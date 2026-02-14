# Cashu × OpenClaw MVP

Initial objective: paid task loop with a human-first web flow.

1. User submits task from web UI or API
2. App creates NUT-23 mint quote (bolt11 invoice) via `@cashu/cashu-ts` (Minibits by default)
3. User pays invoice
4. App verifies quote state (`PAID`/`ISSUED`) and marks task paid
5. Worker automatically executes paid task
6. Result delivered

## Security baseline
- App binds to `127.0.0.1:3000` only.
- Public ingress via nginx only.
- UFW allows only 22/80/443.
- Secrets in `/home/openclaw/cashu-agent.env` (outside workspace).

## Runtime configuration
- `DEFAULT_JOB_PRICE_SATS` (default `100`)
- `WORKER_POLL_MS` (default `1500`)
- `DATA_FILE` (default `app/data/state.json`)
- `MINT_BASE_URL` (default `https://mint.minibits.cash/Bitcoin`)
- `MINT_UNIT` (default `sat`)
- `PAYMENT_VERIFIER_URL` (optional; legacy callback guard if using callback lane)
- `PAYMENT_VERIFIER_TOKEN` (optional bearer token for verifier)

## API

Root app page:
- `GET /` now serves **Clawtar**, a human-first fortune booth UI (ask question -> pay 42 sats -> reveal fortune).
- UI is intentionally simple and can be used as the baseline product UX, while API remains available for agent integrations.

### Clawtar endpoints (new)
- `POST /v1/clawtar` -> create a paid fortune reading (`awaiting_payment`) with mint quote.
- `POST /v1/clawtar/:id/payment/refresh` -> refresh quote state and unlock result when paid.
- `GET /v1/clawtar/:id` -> fetch reading status and result (result hidden until payment).

### `POST /v1/tasks`
Creates a task in `awaiting_payment` state.

Request:
```json
{ "input": "Summarize this repo" }
```

Response (201):
```json
{
  "task_id": "...uuid...",
  "status": "awaiting_payment",
  "quoted_sats": 100,
  "payment": { "method": "cashu", "status": "pending", "instructions": "..." },
  "poll_url": "/v1/tasks/...uuid..."
}
```

### `POST /v1/payments/callback`
Confirms a payment and transitions task `awaiting_payment -> paid`.

Request body:
```json
{
  "task_id": "...uuid...",
  "amount_sats": 100,
  "payment_id": "cashu_tx_001",
  "idempotency_key": "evt_001",
  "proof": { "token": "cashu-proof-or-receipt" }
}
```

Validation/enforcement:
- Task must exist.
- `amount_sats` must exactly match `quoted_sats`.
- `idempotency_key` can only be used once per unique event (`task_id+amount_sats+payment_id`).
- No second transition once task is already paid.
- If a Cashu token proof string is provided in `proof`, backend now decodes it via `@cashu/cashu-ts` and checks token amount >= quoted sats.
- If `PAYMENT_VERIFIER_URL` is configured, callback is accepted only when the verifier returns `{ "ok": true }` (recommended for full proof state checks).

Replay behavior:
- Same `idempotency_key` + same event payload returns deterministic success with `idempotent_replay: true`.
- Same `idempotency_key` + different event payload returns `409 IDEMPOTENCY_KEY_REUSED`.

### `POST /v1/tasks/:id/payment/refresh`
Refreshes mint quote state from NUT-23 endpoint and transitions task to `paid` when quote state is `PAID` or `ISSUED`.

### Worker execution loop
Paid tasks are auto-consumed by a background worker loop.

- Trigger: task transitions to `paid`.
- Poll fallback: worker scans pending quotes + paid tasks every `WORKER_POLL_MS` (default 1500ms).
- Transition: `paid -> running -> completed` (or `failed`).
- Unpaid tasks are never executed.

### `GET /v1/tasks/:id`
Returns task state, payment state, and result (if completed).

### `GET /metrics`
Returns plain text counters:
- `tasks_created_total`
- `payments_received_total`
- `payment_replays_total`
- `tasks_completed_total`
- `tasks_failed_total`

Access control:
- Localhost requests are always allowed.
- Non-local requests require `METRICS_TOKEN` and either `X-Metrics-Token` header or `?token=` query value.

## Quick curl flow (production)

```bash
BASE="https://app.cashutools.dev"

# 1) Create task
CREATE=$(curl -sS -X POST "$BASE/v1/tasks" \
  -H 'content-type: application/json' \
  -d '{"input":"Write a brief on Nostr wallets"}')
echo "$CREATE"
TASK_ID=$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["task_id"])' <<< "$CREATE")

# 2) Payment callback
curl -sS -X POST "$BASE/v1/payments/callback" \
  -H 'content-type: application/json' \
  -d "{\"task_id\":\"$TASK_ID\",\"amount_sats\":100,\"payment_id\":\"cashu_tx_001\",\"idempotency_key\":\"evt_001\"}"

# 3) Poll status (worker auto-runs paid tasks)
sleep 2
curl -sS "$BASE/v1/tasks/$TASK_ID"

# 4) Read metrics (local call)
curl -sS "http://127.0.0.1:3000/metrics"

# 5) Read metrics with token (non-local-safe pattern)
export METRICS_TOKEN="dev-metrics-token"
curl -sS "$BASE/metrics" -H "X-Metrics-Token: $METRICS_TOKEN"
```

## Metrics quick test (local dev)

```bash
# start app
cd app
node server.js

# in another shell, create+pay once (using local base)
BASE="http://127.0.0.1:3000"
CREATE=$(curl -sS -X POST "$BASE/v1/tasks" -H 'content-type: application/json' -d '{"input":"Test metrics"}')
TASK_ID=$(printf '%s' "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
curl -sS -X POST "$BASE/v1/payments/callback" -H 'content-type: application/json' -d "{\"task_id\":\"$TASK_ID\",\"amount_sats\":100,\"payment_id\":\"p1\",\"idempotency_key\":\"k1\"}" >/dev/null
curl -sS -X POST "$BASE/v1/payments/callback" -H 'content-type: application/json' -d "{\"task_id\":\"$TASK_ID\",\"amount_sats\":100,\"payment_id\":\"p1\",\"idempotency_key\":\"k1\"}" >/dev/null
sleep 2
curl -sS "$BASE/metrics"
```

Expected values after the flow above:
- `tasks_created_total 1`
- `payments_received_total 1`
- `payment_replays_total 1`
- `tasks_completed_total 1`
- `tasks_failed_total 0`

## Next implementation steps
- [x] Scaffold Node API + worker
- [x] Payment state machine (`awaiting_payment -> paid -> running -> completed`)
- [x] Idempotent payment callback endpoint
- [x] Human/agent-readable homepage with richer examples + API schema block
- [x] Metrics endpoint and revenue counters
