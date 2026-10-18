# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Implementation Summary

`POST /incidents` is now duplicate-safe. Every request must carry an
`Idempotency-Key` header. The key is stored in `idempotency_keys`, scoped to
the authenticated tenant and the operation (`POST:/incidents`), bound to a
canonical hash of the request body, and used to claim the right to perform the
write exactly once. The incident and its paging job are created together in a
single database transaction, and the completed response is stored so retries
replay the original result instead of creating a second incident.

### Request lifecycle

1. **Validate** — no `Idempotency-Key` header → `400 idempotency_key_required`,
   nothing written.
2. **Hash** — the body is canonicalized (object keys sorted recursively) and
   SHA-256 hashed. Property order does not affect the hash.
3. **Claim atomically** — `INSERT ... ON CONFLICT (tenant_id, operation, key)
   DO NOTHING` creates a `processing` row. Exactly one caller can win this; the
   database `UNIQUE` constraint is the gate.
4. **Winner** — opens a transaction: insert incident → insert paging job →
   update the key row to `completed` with the stored response. Commit. Return
   `201`. If the transaction throws, it rolls back entirely and the key is
   marked `failed`.
5. **Loser / retry** — the claim conflicted, so a row already exists. Branch on
   its stored hash and state:
   - hash differs → `409 idempotency_key_conflict`;
   - `completed` → replay stored response with header `Idempotent-Replayed: true`;
   - `failed` → `409 prior_operation_failed`;
   - `processing` → wait briefly for the in-flight winner to commit, then
     replay; if it never completes within the window → `409
     operation_in_progress`.

### Concurrency model (why 20 duplicates produce one incident)

When 20 identical requests arrive together, all 20 attempt the claiming
`INSERT`. The `UNIQUE (tenant_id, operation, key)` constraint lets exactly one
succeed; the other 19 get no row back. Those 19 then read the key row and find
it `processing` (the winner is still inside its transaction). Rather than
return a premature conflict, they poll briefly — the winner commits in a few
milliseconds — observe the now-`completed` row, and replay its result. All 20
callers receive `201`, but only one incident and one paging job exist. A
lost-response retry (same key, seconds later) takes the same replay path and is
likewise a no-op.

## Design Decisions

### 1. Why database uniqueness is needed

Application-level checks ("look up the key, and if it's missing, insert it")
have a time-of-check-to-time-of-use gap: two concurrent requests can both read
"missing" and both insert. Only a database `UNIQUE` constraint evaluated inside
a single `INSERT ... ON CONFLICT` is truly atomic — the database serializes the
contending inserts and admits exactly one. Uniqueness is scoped to
`(tenant_id, operation, key)`, not the key alone, so one tenant's key never
blocks another's (tenant isolation) and the same key string may be reused for a
different operation.

### 2. How request contents are canonicalized and compared

The body is converted to a canonical form — object keys sorted recursively,
then serialized to JSON — and SHA-256 hashed. Canonicalization makes the hash
independent of JSON property order, so `{title, severity, serviceId}` and
`{serviceId, title, severity}` are treated as the same request. The hash is
stored on first use and compared on every reuse of the key. A matching hash
means "the same logical request, retried" and is safe to replay; a differing
hash means the client reused a key for different contents, which is a client
bug we must surface as `409 idempotency_key_conflict` rather than silently
returning the wrong incident.

### 3. What the 24-hour expiry means

Each key row carries `expires_at = now() + 24h`. Within that window the key is
authoritative: retries replay, conflicts are rejected. The window bounds how
long results and hashes are retained, keeps the dedup table from growing
without limit, and defines when a key may be safely recycled for a genuinely
new request. (A production deployment would run a sweeper to delete or archive
expired rows; the column encodes the contract.)

### 4. Why the paging job is stored in the same transaction

An incident without a page means on-call is never alerted; a page without an
incident is a phantom alert. Writing the incident and the `paging_jobs` row in
one transaction makes the two atomic: either both commit or neither does, so
the durable record and its side-effect obligation can never diverge. The job is
*enqueued* in the transaction, not *delivered* — the actual external page is
sent by a separate worker reading `paging_jobs`, because calling an external
provider inside a database transaction would hold the transaction open on
network latency and could fire the page even if the transaction later rolled
back. The exercise keeps enqueue-in-transaction, deliver-out-of-transaction.

### 5. Privacy and size risks of stored responses

Storing the full response body for replay means the dedup table now holds a
copy of business data, which carries real risks:

- **Privacy / exposure** — incident payloads can contain sensitive fields, so
  the stored copy inherits the same access-control, encryption-at-rest, and
  retention obligations as the primary table; it should not be logged or
  exported casually, and the 24-hour expiry limits how long it lingers.
- **Size / bloat** — large bodies stored per key inflate the table and its
  backups and slow lookups. Mitigations include capping the stored body size,
  storing only what replay needs (here, the created incident), and expiring
  rows. For very large payloads, storing a reference or a status rather than
  the whole body is preferable.
- **Staleness** — a replayed response reflects the entity as it was at creation
  time, not its current state; replay is intentionally a record of the original
  result, not a fresh read.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Passing Test Output

All 14 supplied tests pass against a real PostgreSQL instance (`npm run
db:reset && npm test`):

```text
> jest --runInBand

PASS tests/idempotency.test.js
  ✓ 1 missing key returns 400 and no incident
  ✓ 2 first request creates incident
  ✓ 3 sequential duplicate replays response
  ✓ 4 replay exposes replay header
  ✓ 5 changed body conflicts
  ✓ 6 same key across tenants is independent
  ✓ 7 twenty concurrent duplicates create one incident
  ✓ 8 concurrent duplicates create one paging job
  ✓ 9 lost-response retry produces one effect
  ✓ 10 existing processing key does not execute
  ✓ 11 existing failed key follows recovery contract
  ✓ 12 transaction rollback removes all local writes
  ✓ 13 canonical hash ignores object property order
  ✓ 14 operation and scope are stored exactly

Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
Snapshots:   0 total
Ran all test suites.
```

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
