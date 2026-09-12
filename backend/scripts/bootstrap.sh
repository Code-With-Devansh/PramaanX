#!/usr/bin/env bash
#
# bootstrap.sh — turns "never run Fabric before" into ONE command.
#
# Replaces the manual §5/§6/§9/§10 dance in docs/blockchain.md with a single
# idempotent script. Run it from WSL2 (or native Linux/macOS with Docker):
#
#     bash fabric/scripts/bootstrap.sh
#
# What it does, in order (safe to re-run — every step is skipped if already done):
#   1. Checks prerequisites (docker, curl, jq, node) and explains what's missing.
#   2. Downloads Fabric 2.5 LTS binaries + fabric-samples (only if not present).
#   3. Brings up the 2-org test-network with CAs and creates `legal-channel`.
#   4. Packages, installs, approves, and commits the `document` chaincode.
#   5. Enrolls the Org1 (Police) gateway identity and copies the cert/key/TLS-CA
#      into ./.fabric-crypto (what docker-compose.dev.yml mounts into the API/worker).
#   6. Flips LEDGER_DRIVER=fabric in your .env (creating it from .env.example if needed).
#   7. Runs demo-invoke.sh as a smoke test so you know it actually works.
#
# Total hands-on time: run it, get a coffee. No manual WSL/Fabric knowledge required.
#
# Tear down with: bash fabric/scripts/teardown.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FABRIC_HOME="${FABRIC_HOME:-$HOME/fabric}"
SAMPLES="$FABRIC_HOME/fabric-samples"
TN="$SAMPLES/test-network"
CHANNEL=legal-channel
CC_NAME=document
CC_PATH="$ROOT_DIR/fabric/chaincode/document"
CRYPTO_OUT="$ROOT_DIR/.fabric-crypto"

banner() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
ok()     { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
skip()   { printf '\033[0;33m↷\033[0m %s (already done)\n' "$1"; }

# ---------------------------------------------------------------------------
banner "1/7 Checking prerequisites"
missing=()
for bin in docker curl jq; do
  command -v "$bin" >/dev/null 2>&1 || missing+=("$bin")
done
if ! command -v node >/dev/null 2>&1; then missing+=("node (v20+)"); fi
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing: ${missing[*]}"
  echo
  echo "If you're on Windows, run this whole script from inside WSL2 (not PowerShell):"
  echo "  wsl --install -d Ubuntu   # then reboot, open the Ubuntu app"
  echo "Then inside WSL Ubuntu:"
  echo "  sudo apt update && sudo apt install -y git curl jq build-essential"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  echo "  nvm install 20"
  echo "Also make sure Docker Desktop is running with WSL Integration enabled for"
  echo "this distro (Settings → Resources → WSL Integration), with ≥ 8 GB RAM."
  exit 1
fi
docker info >/dev/null 2>&1 || { echo "Docker isn't running — start Docker Desktop and retry."; exit 1; }
ok "docker, curl, jq, node all present"

# ---------------------------------------------------------------------------
banner "2/7 Fabric binaries + fabric-samples"
if [ -x "$SAMPLES/bin/peer" ] && [ -d "$TN" ]; then
  skip "fabric-samples at $SAMPLES"
else
  mkdir -p "$FABRIC_HOME"
  cd "$FABRIC_HOME"
  curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh \
    | bash -s -- --fabric-version 2.5.9
  ok "installed Fabric 2.5 LTS binaries, docker images, and fabric-samples"
fi
export PATH="$SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$SAMPLES/config"

# ---------------------------------------------------------------------------
banner "3/7 Test network + channel"
cd "$TN"
if docker ps --format '{{.Names}}' | grep -q '^peer0.org1.example.com$'; then
  skip "test-network is up"
else
  ./network.sh up createChannel -c "$CHANNEL" -ca
  ok "network up, channel '$CHANNEL' created (Org1=Police, Org2=Court)"
fi

# ---------------------------------------------------------------------------
banner "4/7 Chaincode: package / install / approve / commit"
if peer lifecycle chaincode querycommitted -C "$CHANNEL" -n "$CC_NAME" >/dev/null 2>&1; then
  skip "chaincode '$CC_NAME' already committed on '$CHANNEL'"
else
  ./network.sh deployCC \
    -ccn "$CC_NAME" -ccp "$CC_PATH" -ccl javascript \
    -c "$CHANNEL" -ccep "OR('Org1MSP.member')"
  ok "chaincode '$CC_NAME' deployed"
fi

# ---------------------------------------------------------------------------
banner "5/7 Gateway identity → .fabric-crypto"
if [ -f "$CRYPTO_OUT/signcert.pem" ] && [ -f "$CRYPTO_OUT/key.pem" ] && [ -f "$CRYPTO_OUT/tls-ca.crt" ]; then
  skip ".fabric-crypto already populated"
else
  mkdir -p "$CRYPTO_OUT"
  ORG1_MSP="$TN/organizations/peerOrganizations/org1.example.com"
  ADMIN_MSP="$ORG1_MSP/users/Admin@org1.example.com/msp"
  # MVP model (docs/blockchain.md §10): one enrolled Org1 (Police) admin identity
  # shared by the gateway. Real per-user identities are a later hardening step.
  cp "$(ls "$ADMIN_MSP"/signcerts/*.pem | head -1)" "$CRYPTO_OUT/signcert.pem"
  cp "$(ls "$ADMIN_MSP"/keystore/*_sk | head -1)"    "$CRYPTO_OUT/key.pem"
  cp "$ORG1_MSP/peers/peer0.org1.example.com/tls/ca.crt" "$CRYPTO_OUT/tls-ca.crt"
  ok "copied signcert.pem, key.pem, tls-ca.crt into .fabric-crypto/ (gitignored)"
fi

# ---------------------------------------------------------------------------
banner "6/7 .env"
cd "$ROOT_DIR"
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }
if grep -q '^LEDGER_DRIVER=fabric' .env; then
  skip "LEDGER_DRIVER already set to fabric"
else
  if grep -q '^LEDGER_DRIVER=' .env; then
    sed -i.bak 's/^LEDGER_DRIVER=.*/LEDGER_DRIVER=fabric/' .env && rm -f .env.bak
  else
    echo 'LEDGER_DRIVER=fabric' >> .env
  fi
  ok "set LEDGER_DRIVER=fabric in .env"
fi

# ---------------------------------------------------------------------------
banner "7/7 Smoke test"
bash "$ROOT_DIR/fabric/scripts/demo-invoke.sh"

banner "Done"
cat <<EOF
Fabric network is up, chaincode is live, .env points at it. Next:
  npm run dev        # api/worker containers now anchor to the real ledger
  bash fabric/scripts/teardown.sh   # when you're done for the day
EOF
