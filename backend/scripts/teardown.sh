#!/usr/bin/env bash
# teardown.sh — stop and remove the Fabric test-network started by bootstrap.sh.
# Chaincode/channel state is destroyed (network.sh down wipes it); crypto material
# in .fabric-crypto and your .env are left alone. Re-run bootstrap.sh to come back up.
set -euo pipefail

FABRIC_HOME="${FABRIC_HOME:-$HOME/fabric}"
TN="$FABRIC_HOME/fabric-samples/test-network"

if [ ! -d "$TN" ]; then
  echo "No fabric-samples found at $TN — nothing to tear down."
  exit 0
fi

cd "$TN"
./network.sh down
echo "Fabric test-network stopped and removed."
