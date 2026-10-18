const crypto = require('crypto');
const { db } = require('./db');

// Fixed identity for this endpoint. The idempotency key is only unique
// *within* a (tenant, operation) scope, so two different endpoints — or two
// different tenants — may reuse the same key string without colliding.
const OPERATION = 'POST:/incidents';

// Exercise expiry. A key is honoured for 24h; after that the same key may be
// reused for a brand-new logical request. (A sweeper/TTL job would reclaim
// expired rows in production; here the column documents and enforces intent.)
const EXPIRY_INTERVAL = "24 hours";

// How long a duplicate request waits for the in-flight original to commit
// before giving up and reporting the operation as still in progress. This is
// what lets 20 concurrent duplicates all succeed: the one that wins the claim
// commits within this window, and the losers observe the committed result and
// replay it, instead of racing to a premature 409.
const WAIT_TOTAL_MS = 2000;
const WAIT_STEP_MS = 20;

/**
 * Canonicalize a request body and hash it.
 *
 * Canonical form = JSON with object keys sorted recursively, so that two
 * bodies that differ only in property order produce an identical hash. The
 * hash binds an idempotency key to the exact contents it was first used with;
 * if a later request reuses the key with different contents, the hashes differ
 * and we reject it as a conflict rather than silently replaying the wrong
 * result.
 */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonicalize(value[k]);
        return acc;
      }, {});
  }
  return value;
}

function hashRequest(body) {
  const canonical = JSON.stringify(canonicalize(body ?? {}));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Serialize a completed idempotency row back into the HTTP response the
// original request produced, flagging it as a replay.
function replayStored(res, row) {
  res.set('Idempotent-Replayed', 'true');
  return res.status(row.response_status).json(row.response_body);
}

async function createIncident(req, res) {
  const tenantId = req.user.tenantId;
  const key = req.get('Idempotency-Key');

  // (1) Require one client idempotency key per logical incident.
  if (!key) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const requestHash = hashRequest(req.body);
  const { title, severity, serviceId } = req.body;

  // (2) Atomic claim. INSERT ... ON CONFLICT DO NOTHING is a single atomic
  //     operation guarded by the UNIQUE(tenant_id, operation, key) constraint.
  //     Exactly one concurrent caller can create the 'processing' row; every
  //     other caller gets no row back and falls through to the replay path.
  const claim = await db.oneOrNone(
    `INSERT INTO idempotency_keys
        (tenant_id, operation, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'processing', now() + interval '${EXPIRY_INTERVAL}')
     ON CONFLICT (tenant_id, operation, key) DO NOTHING
     RETURNING id`,
    [tenantId, OPERATION, key, requestHash]
  );

  if (claim) {
    // ---- We own the claim: do the real work, exactly once. ----------------
    try {
      const incident = await db.tx(async (t) => {
        // (6) Incident and its durable paging job share one transaction, so
        //     an incident can never exist without its page being enqueued,
        //     and a rollback erases both.
        const created = await t.one(
          `INSERT INTO incidents (tenant_id, service_id, title, severity)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [tenantId, serviceId, title, severity]
        );

        await t.none(
          `INSERT INTO paging_jobs (tenant_id, incident_id)
           VALUES ($1, $2)`,
          [tenantId, created.id]
        );

        // Store the completed result on the SAME transaction. The key flips to
        // 'completed' atomically with the writes it describes, so a retry can
        // only ever see a fully-consistent (incident + job + response) record.
        await t.none(
          `UPDATE idempotency_keys
              SET state = 'completed',
                  response_status = 201,
                  response_body = $2,
                  incident_id = $3
            WHERE id = $1`,
          [claim.id, created, created.id]
        );

        return created;
      });

      return res.status(201).json(incident);
    } catch (err) {
      // The transaction rolled back (incident, job, and the 'completed' update
      // are all gone). Mark the claim 'failed' in a separate statement so the
      // key is not left dangling in 'processing' forever, then surface the
      // error. A later retry with this key hits the failed-recovery contract.
      await db.none(
        `UPDATE idempotency_keys SET state = 'failed' WHERE id = $1`,
        [claim.id]
      ).catch(() => {});
      throw err;
    }
  }

  // ---- We did NOT win the claim: a row already exists for this key. --------
  // Resolve it. It may be an older completed/failed row, or an in-flight
  // 'processing' row owned by a concurrent request that is about to commit.
  const deadline = Date.now() + WAIT_TOTAL_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.oneOrNone(
      `SELECT request_hash, state, response_status, response_body
         FROM idempotency_keys
        WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, key]
    );

    // Extremely rare: the owner's transaction rolled back AND reclaimed the
    // row between our failed insert and this read. Retry the whole handler.
    if (!existing) {
      return createIncident(req, res);
    }

    // (5) Same key, changed request contents -> conflict, regardless of state.
    if (existing.request_hash !== requestHash) {
      return res.status(409).json({ error: 'idempotency_key_conflict' });
    }

    if (existing.state === 'completed') {
      // Replay the original stored result.
      return replayStored(res, existing);
    }

    if (existing.state === 'failed') {
      // Recovery contract: the prior attempt failed; do not silently retry.
      return res.status(409).json({ error: 'prior_operation_failed' });
    }

    // state === 'processing': an attempt is in flight. Wait briefly for it to
    // commit, then replay its result. If it never completes within the window
    // (e.g. a genuinely stuck/abandoned claim), report it as in progress.
    if (Date.now() >= deadline) {
      return res.status(409).json({ error: 'operation_in_progress' });
    }
    await sleep(WAIT_STEP_MS);
  }
}

module.exports = { createIncident, hashRequest };
