CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- incidents: the business entity. One row per genuinely distinct incident.
-- ---------------------------------------------------------------------------
CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- idempotency_keys: the deduplication ledger.
--
-- One row claims the right to perform exactly one logical operation. The
-- UNIQUE constraint on (tenant_id, operation, key) is the atomic gate: two
-- concurrent inserts with the same triple cannot both succeed, so only one
-- request ever does the real work. The row also stores the canonical request
-- hash (to detect key reuse with a changed body) and the completed response
-- (to replay the original result on retries).
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope: who + what. The key is only meaningful inside this triple.
  tenant_id       UUID NOT NULL,                 -- authenticated tenant
  operation       TEXT NOT NULL,                 -- e.g. 'POST:/incidents'
  key             TEXT NOT NULL,                 -- client-supplied Idempotency-Key

  -- Binding: ties the key to the exact request contents it first saw.
  request_hash    TEXT NOT NULL,

  -- Lifecycle: 'processing' -> 'completed' | 'failed'.
  state           TEXT NOT NULL
                    CHECK (state IN ('processing','completed','failed')),

  -- Replay payload: the stored result returned to duplicate requests.
  response_status INTEGER,                        -- HTTP status to replay
  response_body   JSONB,                          -- response body to replay
  incident_id     UUID REFERENCES incidents(id),  -- created entity, if any

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,           -- 24h exercise expiry

  -- Atomic ownership: one live claim per tenant + operation + key.
  CONSTRAINT idempotency_keys_scope_unique
    UNIQUE (tenant_id, operation, key)
);

-- Lookups during replay/conflict checks hit exactly this triple.
CREATE INDEX idempotency_keys_lookup
  ON idempotency_keys (tenant_id, operation, key);

-- ---------------------------------------------------------------------------
-- paging_jobs: durable side effect. Written in the SAME transaction as the
-- incident so "incident exists" and "someone was paged" can never diverge.
-- A separate worker later delivers the actual page; we only enqueue here.
-- ---------------------------------------------------------------------------
CREATE TABLE paging_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  incident_id  UUID NOT NULL REFERENCES incidents(id),
  status       TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','sent','failed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX paging_jobs_incident ON paging_jobs (incident_id);
