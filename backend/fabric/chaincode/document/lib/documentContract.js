'use strict';

const { Contract } = require('fabric-contract-api');

// Vocabularies kept in lockstep with DESIGN.md §13 and blockchain.md §4.1.
const CLASSIFICATIONS = ['PUBLIC', 'RESTRICTED', 'CONFIDENTIAL', 'SECRET'];
const CUSTODY_ACTIONS = ['SIGNED', 'TRANSFERRED', 'SEALED', 'LEGAL_HOLD', 'DISCLOSED', 'RESTORED'];

/**
 * DocumentContract — the integrity & chain-of-custody smart contract for the DMS.
 *
 * World-state key = versionId  (== Postgres document_versions.id — that is the
 * join between the ledger and the SQL mirror). The stored value is the
 * LedgerRecord (blockchain.md §4.1). ONLY hashes + lifecycle metadata live on
 * chain; document bytes and PII never touch the ledger.
 *
 * Determinism (this runs on every endorsing peer and every result MUST match,
 * or the transaction fails endorsement):
 *   - time comes from ctx.stub.getTxTimestamp(), never Date.now()
 *   - the submitting org comes from the client cert (getMSPID()), never the payload
 *   - no Math.random(), no timers, no network/HTTP calls
 */
class DocumentContract extends Contract {
  // ── internal helpers ───────────────────────────────────────────────────────

  // Deterministic epoch-seconds from the transaction timestamp. `.seconds` is a
  // protobuf Long; normalise to a plain JS number.
  _txSeconds(ctx) {
    const t = ctx.stub.getTxTimestamp();
    if (!t || t.seconds == null) return 0;
    return typeof t.seconds.toNumber === 'function' ? t.seconds.toNumber() : Number(t.seconds);
  }

  async _get(ctx, versionId) {
    const raw = await ctx.stub.getState(versionId);
    if (!raw || raw.length === 0) return null;
    return JSON.parse(raw.toString());
  }

  async _put(ctx, versionId, record) {
    await ctx.stub.putState(versionId, Buffer.from(JSON.stringify(record)));
  }

  _require(name, value) {
    if (value === undefined || value === null || value === '') {
      throw new Error(`missing required field: ${name}`);
    }
    return value;
  }

  // ── WRITES (submit) ─────────────────────────────────────────────────────────

  /**
   * RegisterDocumentVersion(versionId, payloadJSON)
   *   payload = { docId, caseId, versionNo, sha256, classification, storageRef, actor }
   * Anchors a brand-new document version. Idempotency guard: a versionId can
   * only be registered once.
   */
  async RegisterDocumentVersion(ctx, versionId, payloadJSON) {
    this._require('versionId', versionId);

    const existing = await ctx.stub.getState(versionId);
    if (existing && existing.length > 0) {
      throw new Error(`version ${versionId} is already registered`);
    }

    let p;
    try {
      p = JSON.parse(payloadJSON);
    } catch (e) {
      throw new Error(`payload is not valid JSON: ${e.message}`);
    }

    this._require('docId', p.docId);
    this._require('caseId', p.caseId);
    this._require('sha256', p.sha256);
    this._require('storageRef', p.storageRef);
    this._require('actor', p.actor);

    if (!/^[0-9a-f]{64}$/.test(p.sha256)) {
      throw new Error('sha256 must be a 64-character lowercase hex string');
    }
    if (!CLASSIFICATIONS.includes(p.classification)) {
      throw new Error(`classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
    }

    const record = {
      docType: 'DocumentVersion',
      versionId,
      docId: p.docId,
      caseId: p.caseId,
      versionNo: Number.isFinite(Number(p.versionNo)) ? Number(p.versionNo) : 0,
      sha256: p.sha256,
      classification: p.classification,
      storageRef: p.storageRef,
      actor: p.actor,
      actorOrg: ctx.clientIdentity.getMSPID(), // trusted: derived from the signing cert
      status: 'ACTIVE',
      lastAction: 'REGISTERED',
      lastActor: p.actor,
      ts: this._txSeconds(ctx),
    };

    await this._put(ctx, versionId, record);
    ctx.stub.setEvent(
      'DocumentRegistered',
      Buffer.from(JSON.stringify({ versionId, docId: p.docId, sha256: p.sha256, actorOrg: record.actorOrg })),
    );
    return JSON.stringify(record);
  }

  /**
   * RecordCustodyEvent(versionId, eventJSON)
   *   event = { action, actor, note? }   action ∈ CUSTODY_ACTIONS
   * Records a lifecycle/custody event. Each call is a new putState, so it shows
   * up as a distinct entry in GetDocumentHistory (the chain-of-custody).
   */
  async RecordCustodyEvent(ctx, versionId, eventJSON) {
    const record = await this._get(ctx, versionId);
    if (!record) throw new Error(`version ${versionId} not found`);

    let e;
    try {
      e = JSON.parse(eventJSON);
    } catch (err) {
      throw new Error(`event is not valid JSON: ${err.message}`);
    }
    this._require('action', e.action);
    this._require('actor', e.actor);
    if (!CUSTODY_ACTIONS.includes(e.action)) {
      throw new Error(`action must be one of: ${CUSTODY_ACTIONS.join(', ')}`);
    }

    // A sealed record is frozen; only DISCLOSED (a read-out) may still be logged.
    if (record.status === 'SEALED' && e.action !== 'DISCLOSED') {
      throw new Error(`version ${versionId} is SEALED; action ${e.action} is not permitted`);
    }

    if (e.action === 'SEALED') record.status = 'SEALED';
    if (e.action === 'LEGAL_HOLD') record.status = 'LEGAL_HOLD';
    record.lastAction = e.action;
    record.lastActor = e.actor;
    if (e.note) record.lastNote = e.note;
    record.ts = this._txSeconds(ctx);

    await this._put(ctx, versionId, record);
    ctx.stub.setEvent(
      'CustodyEventRecorded',
      Buffer.from(JSON.stringify({ versionId, action: e.action, actor: e.actor })),
    );
    return JSON.stringify(record);
  }

  /**
   * SealDocument(versionId, actor)
   * Intended to be deployed under an AND('Org1MSP.member','Org2MSP.member')
   * endorsement policy so a document cannot be sealed without BOTH Police and
   * Court endorsing (blockchain.md §6). The chaincode only flips status here;
   * the cross-org guarantee is the endorsement policy at commit time.
   */
  async SealDocument(ctx, versionId, actor) {
    this._require('actor', actor);
    const record = await this._get(ctx, versionId);
    if (!record) throw new Error(`version ${versionId} not found`);
    if (record.status === 'SEALED') throw new Error(`version ${versionId} is already SEALED`);

    record.status = 'SEALED';
    record.lastAction = 'SEALED';
    record.lastActor = actor;
    record.ts = this._txSeconds(ctx);

    await this._put(ctx, versionId, record);
    ctx.stub.setEvent(
      'DocumentSealed',
      Buffer.from(JSON.stringify({ versionId, actor, actorOrg: ctx.clientIdentity.getMSPID() })),
    );
    return JSON.stringify(record);
  }

  // ── READS (evaluate) ─────────────────────────────────────────────────────────

  /**
   * VerifyHash(versionId, sha256) -> { match, record }
   * The demo money-shot: compares a freshly computed file hash against what was
   * anchored. match:false when the stored bytes were tampered with.
   */
  async VerifyHash(ctx, versionId, sha256) {
    const record = await this._get(ctx, versionId);
    if (!record) return JSON.stringify({ match: false, record: null });
    return JSON.stringify({ match: record.sha256 === sha256, record });
  }

  // Returns the LedgerRecord JSON, or an empty payload when unknown (the
  // integration layer maps empty -> null).
  async GetVersion(ctx, versionId) {
    const record = await this._get(ctx, versionId);
    return record ? JSON.stringify(record) : '';
  }

  /**
   * GetDocumentHistory(versionId) -> [{ txId, timestamp, isDelete, value }]
   * getHistoryForKey IS the tamper-proof chain-of-custody — every putState to
   * this key, in order, straight from the ledger.
   */
  async GetDocumentHistory(ctx, versionId) {
    const iterator = await ctx.stub.getHistoryForKey(versionId);
    const history = [];
    let res = await iterator.next();
    while (!res.done) {
      const m = res.value;
      let ts = 0;
      if (m.timestamp && m.timestamp.seconds != null) {
        ts = typeof m.timestamp.seconds.toNumber === 'function'
          ? m.timestamp.seconds.toNumber()
          : Number(m.timestamp.seconds);
      }
      history.push({
        txId: m.txId,
        timestamp: ts,
        isDelete: m.isDelete,
        value: m.value && m.value.length ? JSON.parse(m.value.toString()) : null,
      });
      res = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(history);
  }
}

module.exports = DocumentContract;
