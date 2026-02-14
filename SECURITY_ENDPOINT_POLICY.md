# Endpoint Exposure Policy (v1)

## Publicly reachable
- `GET /healthz`
- `POST /webhooks/telegram` (secret-validated)
- `POST /payments/callback` (signature or one-time token + idempotency key)

## Must NOT be public
- `/admin/*`
- `/metrics` (internal only or IP allowlist + auth)
- Any debug endpoints
- Raw OpenClaw/Gateway interfaces

## Reverse-proxy controls
- Rate limit all public routes
- Small request body limits
- Strict timeouts
- Reject unknown methods
- Add request id header

## Payment safety controls
- Never execute a paid job without durable `payment_status=paid`.
- Bind payment to `job_id` + exact quoted amount.
- Idempotency key required on callbacks.
- Reject duplicate or amount-mismatch callbacks.
- No prompt content can alter pricing or payout logic.
