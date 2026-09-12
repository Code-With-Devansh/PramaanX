# Builds the DocumentContract chaincode as a standalone CCaaS server.
#
# Build and run this yourself with your own `docker build`/`docker run` —
# that's the whole point of CCaaS: the peer never invokes Docker at all, so
# it never hits the removed legacy-build-API error that
# `peer lifecycle chaincode install` triggers on modern Docker Engines
# (confirmed on Docker Server 29.1.3).
#
# Runs via `fabric-chaincode-node server` (fabric-shim's own CLI, verified
# against the installed fabric-shim@2.5.4 — its public API does NOT export
# ChaincodeServer/ChaincodeFromContract directly, so don't hand-roll a
# server.js; this CLI is the supported entrypoint and reads its config from
# CORE_-prefixed env vars, e.g.:
#
#   docker build -t document-ccaas:1.0 .
#   docker run -d --name document-ccaas \
#     --network fabric_test \
#     -e CORE_CHAINCODE_ID=document_1.0:<sha256-from-queryinstalled> \
#     -e CORE_CHAINCODE_ADDRESS=0.0.0.0:9999 \
#     -p 9999:9999 \
#     document-ccaas:1.0
#
# --network fabric_test must match the Docker network test-network creates
# (check with `docker network ls`) so the peer container can reach this one
# by container name/IP. For TLS, also set CORE_CHAINCODE_TLS_CERT_FILE /
# CORE_CHAINCODE_TLS_KEY_FILE / CORE_CHAINCODE_TLS_CLIENT_CACERT_FILE and
# mount the corresponding cert/key files in.

FROM node:20-alpine

WORKDIR /usr/src/app

# Install dependencies first so this layer is cached across code-only changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Chaincode source. index.js/lib are required by fabric-chaincode-node's
# bootstrap (it reads package.json's "main" to find the Contract classes).
COPY index.js ./
COPY lib ./lib

# Unprivileged user — this process has no need for root.
RUN addgroup -S chaincode && adduser -S chaincode -G chaincode
USER chaincode

EXPOSE 9999

CMD ["npm", "run", "start:ccaas"]
