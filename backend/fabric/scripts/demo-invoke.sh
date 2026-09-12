#!/usr/bin/env bash
#
# demo-invoke.sh — proves the DocumentContract chaincode end-to-end against the
# WSL test-network (Police=Org1MSP / Court=Org2MSP on legal-channel).
#
# Flow:
#   1. RegisterDocumentVersion  (anchor a version's sha256 + metadata)
#   2. GetVersion               (read it back)
#   3. VerifyHash  correct hash (expect match:true)
#   4. VerifyHash  tampered hash (expect match:false)  <- the integrity money-shot
#   5. RecordCustodyEvent TRANSFERRED
#   6. RecordCustodyEvent DISCLOSED
#   7. GetDocumentHistory       (expect 3 immutable entries)
#
# Run from WSL:  bash /mnt/d/CodeBase/Projects/DMS/fabric/scripts/demo-invoke.sh
set -euo pipefail

TN="$HOME/fabric/fabric-samples/test-network"
export PATH="$HOME/fabric/fabric-samples/bin:$PATH"
export FABRIC_CFG_PATH="$HOME/fabric/fabric-samples/config"

# --- act as Org1 (Police) admin ---------------------------------------------
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID=Org1MSP
export CORE_PEER_TLS_ROOTCERT_FILE="$TN/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$TN/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS=localhost:7051
ORDERER_CA="$TN/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem"
ORG1_TLS="$TN/organizations/peerOrganizations/org1.example.com/tlsca/tlsca.org1.example.com-cert.pem"

CHANNEL=legal-channel
CC=document

banner () { printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"; }

# Build a chaincode invocation request: ctor <Fn> <arg1> <arg2> ...
ctor () {
  local fn=$1; shift
  local args
  args=$(printf '%s\n' "$@" | jq -R . | jq -cs .)
  jq -cn --arg fn "$fn" --argjson args "$args" '{function:$fn, Args:$args}'
}

invoke () {
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" -C "$CHANNEL" -n "$CC" \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_TLS" \
    -c "$1"
}
query () { peer chaincode query -C "$CHANNEL" -n "$CC" -c "$1"; }

# --- deterministic-ish test data (ids fresh per run so it is re-runnable) ----
VID=$(cat /proc/sys/kernel/random/uuid)
DOC=$(cat /proc/sys/kernel/random/uuid)
CASE=$(cat /proc/sys/kernel/random/uuid)
REF="cases/$CASE/$DOC/$VID"
ACTOR="00000000-0000-0000-0000-000000000001"   # == the backend dev-identity shim
SHA=$(printf '%s' "Chain-of-custody demo — FIR scan bytes v1" | sha256sum | cut -d' ' -f1)
BAD=$(printf '%s' "tampered bytes — someone swapped the file" | sha256sum | cut -d' ' -f1)

banner "test data"
echo "versionId : $VID"
echo "storageRef: $REF"
echo "sha256    : $SHA"

banner "1. RegisterDocumentVersion"
PAYLOAD=$(jq -cn --arg docId "$DOC" --arg caseId "$CASE" --argjson versionNo 1 \
  --arg sha "$SHA" --arg cls "CONFIDENTIAL" --arg ref "$REF" --arg actor "$ACTOR" \
  '{docId:$docId,caseId:$caseId,versionNo:$versionNo,sha256:$sha,classification:$cls,storageRef:$ref,actor:$actor}')
invoke "$(ctor RegisterDocumentVersion "$VID" "$PAYLOAD")"
sleep 3

banner "2. GetVersion"
query "$(ctor GetVersion "$VID")" | jq .

banner "3. VerifyHash — correct hash (expect match:true)"
OUT=$(query "$(ctor VerifyHash "$VID" "$SHA")")
echo "$OUT" | jq '{match, status: .record.status, actorOrg: .record.actorOrg}'
[ "$(echo "$OUT" | jq -r .match)" = "true" ] \
  && echo -e "\033[1;32mPASS\033[0m: freshly computed hash matches the anchored value" \
  || { echo -e "\033[1;31mFAIL\033[0m"; exit 1; }

banner "4. VerifyHash — tampered hash (expect match:false)"
OUT=$(query "$(ctor VerifyHash "$VID" "$BAD")")
echo "$OUT" | jq '{match}'
[ "$(echo "$OUT" | jq -r .match)" = "false" ] \
  && echo -e "\033[1;32mPASS\033[0m: tampered bytes are detected — hash mismatch" \
  || { echo -e "\033[1;31mFAIL\033[0m"; exit 1; }

banner "5. RecordCustodyEvent — TRANSFERRED"
EV=$(jq -cn --arg a TRANSFERRED --arg actor "$ACTOR" --arg note "handed to evidence room" \
  '{action:$a,actor:$actor,note:$note}')
invoke "$(ctor RecordCustodyEvent "$VID" "$EV")"
sleep 3

banner "6. RecordCustodyEvent — DISCLOSED"
EV=$(jq -cn --arg a DISCLOSED --arg actor "$ACTOR" --arg note "disclosed to defense counsel" \
  '{action:$a,actor:$actor,note:$note}')
invoke "$(ctor RecordCustodyEvent "$VID" "$EV")"
sleep 3

banner "7. GetDocumentHistory — the tamper-proof chain-of-custody"
H=$(query "$(ctor GetDocumentHistory "$VID")")
echo "$H" | jq 'map({txId: (.txId[0:12] + "…"), ts: .timestamp, action: .value.lastAction, status: .value.status, by: .value.lastActor})'
N=$(echo "$H" | jq 'length')
echo "history entries: $N (expect 3: REGISTERED → TRANSFERRED → DISCLOSED)"
[ "$N" = "3" ] \
  && echo -e "\033[1;32mPASS\033[0m: full custody trail present and ordered" \
  || { echo -e "\033[1;31mFAIL\033[0m"; exit 1; }

banner "DONE — DocumentContract verified end-to-end"
echo "versionId for further poking: $VID"
