import { test } from "node:test";
import assert from "node:assert/strict";
import {
  marshalRegister,
  parseRecord,
  isAlreadyRegistered,
  isAlreadySealed,
} from "./fabricLedger.js";

// Pure adapter helpers behind FabricLedgerService — the marshalling into the
// chaincode's argument shape and the idempotency detectors. These are exercised
// without a live network (that is what the Phase-2 integration steps cover); here
// we pin the wire contract and the "already registered / already SEALED -> success"
// classification independently of any gRPC/gateway infra. Importing this module
// does NOT require @grpc/grpc-js or @hyperledger/fabric-gateway — those load lazily
// inside createFabricLedgerService, so this test runs on a plain host checkout.

const enc = (obj) => new TextEncoder().encode(JSON.stringify(obj));

test("marshalRegister emits [versionId, payloadJSON] with only the caller-set fields", () => {
  const [versionId, payloadJSON] = marshalRegister({
    versionId: "v-1",
    docId: "d-1",
    caseId: "c-1",
    versionNo: 3,
    sha256: "a".repeat(64),
    classification: "CONFIDENTIAL",
    storageRef: "cases/c-1/d-1/v-1",
    actor: "u-1",
  });
  assert.equal(versionId, "v-1");
  const payload = JSON.parse(payloadJSON);
  assert.deepEqual(payload, {
    docId: "d-1",
    caseId: "c-1",
    versionNo: 3,
    sha256: "a".repeat(64),
    classification: "CONFIDENTIAL",
    storageRef: "cases/c-1/d-1/v-1",
    actor: "u-1",
  });
  // On-chain-derived fields must never be sent by the client (the chaincode sets
  // them from the signing cert + tx timestamp).
  assert.ok(!("actorOrg" in payload));
  assert.ok(!("status" in payload));
  assert.ok(!("ts" in payload));
  // versionNo stays a JSON number, not a string.
  assert.equal(typeof payload.versionNo, "number");
});

test("parseRecord decodes a Uint8Array of JSON into the record object", () => {
  const record = { versionId: "v-1", sha256: "b".repeat(64), status: "ACTIVE" };
  assert.deepEqual(parseRecord(enc(record)), record);
});

test("parseRecord accepts a plain string payload", () => {
  assert.deepEqual(parseRecord('{"status":"SEALED"}'), { status: "SEALED" });
});

test("parseRecord maps empty payloads to null (the chaincode's '' = not found)", () => {
  assert.equal(parseRecord(""), null);
  assert.equal(parseRecord(new Uint8Array(0)), null);
  assert.equal(parseRecord(null), null);
  assert.equal(parseRecord(undefined), null);
});

test("isAlreadyRegistered matches the chaincode duplicate-register message", () => {
  assert.equal(
    isAlreadyRegistered(new Error("version v-1 is already registered")),
    true,
  );
  assert.equal(isAlreadyRegistered(new Error("version v-1 not found")), false);
});

test("isAlreadyRegistered finds the message buried in a gateway error's details[]", () => {
  // fabric-gateway surfaces the chaincode string in per-endorser details, not
  // always in .message — the detector must scan both.
  const gatewayErr = Object.assign(new Error("failed to endorse transaction"), {
    code: 2,
    details: [
      { address: "host.docker.internal:7051", mspId: "Org1MSP", message: "version v-1 is already registered" },
    ],
  });
  assert.equal(isAlreadyRegistered(gatewayErr), true);
});

test("isAlreadySealed matches the seal message (in .message or .details), not register", () => {
  assert.equal(isAlreadySealed(new Error("version v-1 is already SEALED")), true);
  const gatewayErr = Object.assign(new Error("failed to endorse transaction"), {
    details: [{ message: "version v-1 is already SEALED" }],
  });
  assert.equal(isAlreadySealed(gatewayErr), true);
  // The two detectors are distinct — neither fires on the other's message.
  assert.equal(isAlreadySealed(new Error("version v-1 is already registered")), false);
  assert.equal(isAlreadyRegistered(new Error("version v-1 is already SEALED")), false);
});

test("idempotency detectors tolerate null/undefined/string errors", () => {
  assert.equal(isAlreadyRegistered(null), false);
  assert.equal(isAlreadySealed(undefined), false);
  assert.equal(isAlreadyRegistered("version v-1 is already registered"), true);
});
