# 402 × OpenClaw × Cashu (NUT-24) — Use Case Options

Date: 2026-02-13

## Synthesis from two sub-agent roles
- Plant (creative): proposed strong human workflow wedges where agent execution is the moat.
- Monitor/Implementer (skeptical): prioritized near-term defensibility and 1-day shippability.

## Top 3 candidates

### 1) Paid Tool Gateway for agents (**recommended**)
**Who:** OpenClaw builders + automators.

**Pain:** Agents can call free APIs, but handling paid endpoints/contracts is messy.

**Why not just ChatGPT:** ChatGPT won’t natively execute an idempotent 402 challenge/settle/retry loop across arbitrary tools with a per-call policy ledger.

**402 payment moment:** first protected tool call and each paid API call thereafter.

**Human UX (6-step max):**
1. Add funds (Cashu).
2. Pick tool pack.
3. Run workflow.
4. System auto-handles 402 in background.
5. Show receipts + costs per call.
6. Export ledger.

**48h MVP:**
- One protected endpoint + one mint.
- Automatic 402 settle/retry path.
- Per-request idempotency + payment log.
- Minimal balance + spend view.

**T.I.M.E:** Time✅ Image✅ Money✅ Effort✅

---

### 2) Invoice Chaser + Proof Pack
**Who:** freelancers/agencies chasing overdue invoices.

**Pain:** painful, manual collections workflow.

**Moat:** always-on monitor + timed escalation + proof bundle generation tied to real workflow action.

**402 payment moment:** unlock escalation send sequence and/or pay-per-recovered invoice action.

**48h MVP:** CSV overdue upload, draft escalation sequence, one-click send flow, recovery dashboard.

**T.I.M.E:** Time✅ Image✅ Money✅✅ Effort✅

---

### 3) Form-Filler for high-friction portals
**Who:** small operators repeatedly filing forms/claims.

**Pain:** repetitive, brittle portal work.

**Moat:** browser execution + recovery from broken form states + submission proof pack.

**402 payment moment:** before final submit and for retry-recovery flow.

**48h MVP:** 1-2 demo portal workflows, profile/doc vault, final submit gate.

**T.I.M.E:** Time✅✅ Image✅ Money✅ Effort✅✅

---

## Selection for current build
- **Primary:** Paid Tool Gateway (best practical + defensible for 402-native architecture).
- **Backup:** Invoice Chaser (strong direct ROI narrative for humans).

## Acceptance criteria for Primary (next milestone)
1. Unpaid request receives standards-compliant 402 challenge.
2. Wallet settlement + retry returns 200 successfully.
3. Exactly-once charge on retries (idempotency proven).
4. p95 overhead from payment flow < 1.2s in test environment.
5. User-visible per-call ledger shows endpoint, sats, timestamp, status.
