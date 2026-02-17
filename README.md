# Clawtar

Clawtar is an agent-first Cashu HTTP 402 demo:

1. Agent calls `POST /v1/clawtar/ask`
2. Server responds `402` with `x-cashu` containing a NUT-24 challenge (encoded NUT-18 `creqA...`)
3. Agent creates a Cashu token and retries with `X-Cashu: <cashu-token>`
4. Server returns a paid fortune response

## Endpoint

- `POST https://clawtar.cashutools.dev/v1/clawtar/ask`

Request body:

```json
{
  "question": "Will this ship?",
  "style": "funny"
}
```

Styles:
- `funny`
- `chaotic`
- `wholesome`

Behavior:
- Omit `style` => server picks a random style
- Blank/invalid `style` => `400`
- Blank `question` => `400`

## API behavior

### Unpaid request
Returns `402` with `x-cashu` challenge:

- `x-cashu: creqA...`

### Paid request
Retry same request with:

- `X-Cashu: <cashu-token>`

Response:

```json
{
  "ok": true,
  "quoted_sats": 42,
  "result": {
    "title": "Clawtar says ...",
    "style": "wholesome",
    "question": "Will this ship?",
    "fortune": "...",
    "lucky_number": 17
  }
}
```

## Public read endpoints

- `GET /` (public page)
- `GET /v1/clawtar/recent`
- `GET /v1/clawtar/stats`
- `GET /healthz`

## Local dev

```bash
cd app
npm ci
node server.js
```

Then test:

```bash
curl -i -sS -X POST "http://127.0.0.1:3000/v1/clawtar/ask" \
  -H "content-type: application/json" \
  -d '{"question":"terminal check"}'
```

## Notes

- Legacy task endpoints are retired (`/v1/tasks*`, `/v1/payments/callback` return `410`).
- Runtime secrets should come from environment files outside source control.
