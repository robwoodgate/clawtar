const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PaymentRequest } = require('@cashu/cashu-ts');
const { execFileSync } = require('child_process');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3000;

// Clawtar pricing + limits
const CLAWTAR_PRICE_SATS = Number(process.env.CLAWTAR_PRICE_SATS || 42);
const CLAWTAR_RECENT_MAX = Number(process.env.CLAWTAR_RECENT_MAX || 500);
const CLAWTAR_LEDGER_MAX = Number(process.env.CLAWTAR_LEDGER_MAX || 500);

// Storage
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'state.json');

// Cashu + wallet tooling
const MINT_BASE_URL = process.env.MINT_BASE_URL || 'https://mint.minibits.cash/Bitcoin';
const MINT_UNIT = process.env.MINT_UNIT || 'sat';
const COCOD_BIN = process.env.COCOD_BIN || '/home/openclaw/.bun/bin/cocod';
const BUN_BIN = process.env.BUN_BIN || '/home/openclaw/.bun/bin/bun';

// Optional Telegram activity pings
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ACTIVITY_NOTIFY_ENABLED = (process.env.ACTIVITY_NOTIFY_ENABLED || 'true').toLowerCase() !== 'false';

let clawtarRecent = [];
let clawtarTotals = { paid_count: 0, sats_received: 0 };
let walletLedger = [];

function now() {
  return new Date().toISOString();
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function recomputeTotalsFromLedger() {
  const receives = walletLedger.filter((x) => x?.type === 'clawtar_ask_receive');
  clawtarTotals = {
    paid_count: receives.length,
    sats_received: receives.reduce((sum, x) => sum + (Number(x?.amount_sats) || 0), 0),
  };
}

function saveState() {
  ensureDataDir();

  const payload = {
    saved_at: now(),
    clawtar_recent: clawtarRecent,
    clawtar_totals: clawtarTotals,
    wallet_ledger: walletLedger,
  };

  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw.trim()) return;

    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed.clawtar_recent)) {
      clawtarRecent = parsed.clawtar_recent;
    }

    if (Array.isArray(parsed.wallet_ledger)) {
      walletLedger = parsed.wallet_ledger;
    }

    if (parsed.clawtar_totals && typeof parsed.clawtar_totals === 'object') {
      clawtarTotals = {
        paid_count: Number(parsed.clawtar_totals.paid_count || 0),
        sats_received: Number(parsed.clawtar_totals.sats_received || 0),
      };
    } else {
      recomputeTotalsFromLedger();
    }
  } catch (err) {
    console.error('failed to load state, starting fresh:', err.message);
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function runCocod(args, timeout = 20000) {
  return execFileSync(BUN_BIN, [COCOD_BIN, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function receiveTokenToAppWallet(proofToken) {
  try {
    const out = runCocod(['receive', 'cashu', proofToken], 20000);

    const match = out.match(/Received\s+(\d+)/i);
    const amount = match ? Number(match[1]) : null;

    return { ok: true, amount, raw: out };
  } catch (err) {
    const stderr = err?.stderr ? String(err.stderr).trim() : '';
    const stdout = err?.stdout ? String(err.stdout).trim() : '';
    const msg = stderr || stdout || err?.message || 'receive failed';
    return { ok: false, reason: msg };
  }
}

function getAppWalletBalance() {
  try {
    const out = runCocod(['balance'], 10000);

    const parsed = JSON.parse(out);
    const entries = Object.entries(parsed || {});
    const total = entries.reduce((sum, [_mint, v]) => sum + (Number(v?.sats) || 0), 0);
    return { ok: true, total_sats: total, by_mint: parsed };
  } catch (err) {
    return { ok: false, error: err?.message || 'balance check failed' };
  }
}

async function notifyClawtarActivity({ style, amountSats, visits, appBalanceSats }) {
  if (!ACTIVITY_NOTIFY_ENABLED) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const msg = [
    '🦀✨ <b>New Clawtar activity!</b>',
    '',
    `An agent just paid <b>${amountSats} sats</b> and unlocked a fortune.`,
    `Style: <b>${escapeHtml(style || 'funny')}</b>`,
    '',
    `Total recent paid visits: <b>${visits}</b>`,
    Number.isFinite(appBalanceSats) ? `App wallet balance: <b>${appBalanceSats} sats</b>` : '',
  ].filter(Boolean).join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('clawtar activity notify failed:', err?.message || err);
  }
}

function clawtarStats() {
  return {
    total_paid: Number(clawtarTotals.paid_count || 0),
    visible_recent: clawtarRecent.length,
  };
}

function extractFortuneIntro(fortune) {
  const s = String(fortune || '');
  const i = s.indexOf(':');
  if (i <= 0) return s;
  return s.slice(0, i).trim();
}

function extractFortuneTail(fortune) {
  const s = String(fortune || '');
  const i = s.indexOf(':');
  if (i < 0) return s.trim();
  return s.slice(i + 1).trim();
}

function pickClawtarFortune({ question, style, seed }) {
  const intros = [
    'The claw stirs the neon fog',
    'A copper lobster whispers through static',
    'From the velvet booth of Clawtar',
    'A tiny bell rings inside the machine',
    'Lantern light flickers across the shell',
    'The oracle crab taps once on glass',
    'Neon tides roll under your keyboard',
    'Moonlight pools under a forgotten commit',
    'A hidden stair appears behind your dashboard',
    'The shell hums like an old data center',
    'Somewhere, a pager chirps in perfect rhythm',
    'A radio crackles from the edge of the map',
    'Dust spins in a beam of terminal light',
    'A small red LED blinks like a heartbeat',
    'The booth door clicks shut behind you',
    'Rain taps softly on the arcade roof',
    'A pager from another timeline goes off once',
    'The crab adjusts its tiny spectacles',
    'The room smells faintly of ozone and coffee',
    'A low synth note settles in the floorboards',
  ];

  const funnyA = [
    'Treat this like a side quest with snacks',
    'Choose the version that future-you can explain calmly',
    'Pick the less dramatic path and call it wisdom',
    'Do the obvious thing, but with suspiciously good manners',
    'Start with the boring move that secretly wins',
    'Aim for progress, not a cinematic meltdown',
    'Take one confident step before opening ten new tabs',
    'Keep it simple enough to survive a Monday morning',
    'Let clarity wear the crown today',
    'Solve the real problem, not the loudest one',
    'Choose momentum that doesn’t break your sleep schedule',
    'Ship the clean slice, save the opera for v2',
    'Respect your energy budget like it’s production infra',
    'Pick the answer that needs fewer apology messages',
    'Make the choice that reduces tomorrow’s chaos tax',
    'Proceed with ambition and at least one sip of water',
  ];
  const funnyB = [
    'then reward yourself with unreasonable confidence',
    'and leave one elegant note for tomorrow-you',
    'before your inner goblin starts refactoring everything',
    'while the universe is briefly cooperative',
    'and do not negotiate with random TODOs',
    'before scope creep learns your home address',
    'and keep one hand on the rollback button',
    'without summoning a committee of browser tabs',
    'and retire one cursed workaround while you’re there',
    'before the coffee wears off and philosophy begins',
    'and make it understandable to a sleepy teammate',
    'with enough polish to feel intentional, not accidental',
    'then close the loop instead of opening five more',
    'and keep your standards higher than your caffeine level',
    'while your brain is still in constructive mode',
    'and absolutely no hotfixes from the supermarket queue',
  ];
  const funnyC = [
    'Your keyboard approves with a tiny, judgmental nod.',
    'If it works first try, act natural.',
    'The rubber duck is taking minutes and seems impressed.',
    'You are allowed to call this “strategy,” not luck.',
    'A small victory dance is operationally justified.',
    'Even the linting daemon looks oddly supportive today.',
    'Future-you just sent a thank-you from next Tuesday.',
    'This is the kind of boring success people brag about later.',
  ];

  const chaoticA = [
    'Move before doubt decorates itself as certainty',
    'Take the bold route, then secure the edges',
    'Follow the signal that feels alive, not loud',
    'Turn pressure into direction, not noise',
    'Choose motion over immaculate hesitation',
    'Cut through the fog with one decisive action',
    'Let courage lead, but keep receipts',
    'Use the strange opening while it still exists',
    'Lean into momentum with your eyes open',
    'Make the call that changes the map',
    'Trust your instincts, then verify your assumptions',
    'Push the frontier one notch forward',
    'Break the loop and name the cost upfront',
    'Take the leap, but bring a landing plan',
    'Open the side door no one is guarding',
    'Choose the path that teaches you something real',
  ];
  const chaoticB = [
    'before comfort writes a fake veto',
    'and let reality give the final review',
    'while timing still favors the brave',
    'with one eye on risk and one on opportunity',
    'and keep rollback fuel in reserve',
    'before consensus dilutes the signal',
    'then document the blast radius like a pro',
    'without confusing speed for aim',
    'and own the consequences with style',
    'before the window closes quietly',
    'and keep the mission bigger than the mood',
    'while luck is still near the keyboard',
    'then stabilize fast and move again',
    'with clarity sharper than adrenaline',
    'and refuse to worship hesitation',
    'without letting chaos drive the steering wheel',
  ];
  const chaoticC = [
    'The map redraws itself when you commit to a direction.',
    'Entropy can be a drumbeat if you keep tempo.',
    'A door opens only for people already in motion.',
    'Bold moves age well when backed by clean notes.',
    'Chaos respects builders who label their exits.',
    'Tonight rewards decisive people with steady hands.',
    'Momentum is a tool; keep it pointed at the right thing.',
    'The storm is useful when you still own the compass.',
  ];

  const wholesomeA = [
    'You are closer than you think',
    'Steady effort is quietly compounding',
    'Your patience is carrying real weight',
    'This can grow without rushing',
    'Kindness is still a high-performance strategy',
    'Small steps count more than loud ones',
    'Your consistency is visible from here',
    'You can trust the craft you’ve practiced',
    'Progress is happening beneath the surface',
    'A calm approach will hold',
    'You are building something that lasts',
    'Your rhythm is stronger than urgency',
    'You are allowed to choose depth over speed',
    'The long game is already working in your favor',
    'Quiet discipline is doing heavy lifting',
    'Today’s gentle move still changes tomorrow',
  ];
  const wholesomeB = [
    'keep going one honest step at a time',
    'choose the kind option and ship the small win',
    'don’t rush what is already unfolding well',
    'your future self will thank this discipline',
    'imperfect and shipped beats perfect and hidden',
    'rest is part of the work, not a detour',
    'one clear note now saves a hard morning later',
    'boring good habits are doing quiet magic',
    'hold the line; this is working',
    'trust the long arc over loud urgency',
    'protect your energy and your standards together',
    'today only needs one meaningful action',
    'let clarity be enough for this step',
    'leave things a little better than you found them',
    'trade panic for presence and proceed',
    'keep your promises to yourself first',
  ];
  const wholesomeC = [
    'Something gentle and useful is about to click.',
    'You are not late; you are laying durable foundations.',
    'The work is noticing you back.',
    'Your care is part of the outcome, not extra.',
    'This pace is sustainable, and that is power.',
    'A quiet win today can echo for weeks.',
    'You’re building trust with every small finish.',
    'Stability is a feature, not a lack of ambition.',
  ];

  const bank = {
    funny: [funnyA, funnyB, funnyC],
    chaotic: [chaoticA, chaoticB, chaoticC],
    wholesome: [wholesomeA, wholesomeB, wholesomeC],
  };

  const [poolA, poolB, poolC] = bank[style] || bank.funny;
  const intro = intros[seed % intros.length];
  const lineA = poolA[seed % poolA.length];
  const lineB = poolB[Math.floor(seed / 7) % poolB.length];
  const lineC = poolC[Math.floor(seed / 17) % poolC.length];
  const vibe = ['🦞', '🔮', '⚡', '🌙', '✨', '🧿', '🪐', '🦀'][seed % 8];

  return {
    title: `Clawtar says ${vibe}`,
    style,
    question,
    fortune: `${intro}: ${lineA} ${lineB}. ${lineC}`,
    lucky_number: (seed % 77) + 1,
  };
}

function toSeed(input) {
  const hex = crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
  return parseInt(hex, 16);
}

app.get('/healthz', (_req, res) => {
  return res.status(200).json({ ok: true, ts: now() });
});

app.get('/', (_req, res) => {
  res.set('cache-control', 'no-store');
  res.type('text/html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clawtar — Agent Fortune Booth</title>
  <style>
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system; color:#ffe8c2; background: radial-gradient(circle at top, #3a0f44 0%, #1c082d 45%, #090414 100%); }
    .wrap { max-width: 920px; margin: 0 auto; padding: 24px; }
    .hero { text-align:center; padding: 24px; border:1px solid #6f3f8f; border-radius:16px; background: rgba(20,8,35,.7); box-shadow: 0 10px 40px rgba(0,0,0,.35); }
    .hero h1 { margin:0; font-size: 46px; letter-spacing: 1px; }
    .hero p { color:#e4c4ff; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:16px; }
    .card { padding:16px; border-radius:14px; border:1px solid #66418f; background: rgba(15,7,28,.75); }
    pre { white-space:pre-wrap; word-break:break-word; background:#12081f; border-radius:10px; padding:10px; border:1px solid #5f3c84; }
    .muted { color:#d5aef8; font-size:13px; }
    .fortune { border:1px solid #7f56aa; border-radius:10px; padding:10px; margin-top:8px; background:#150a26; }
    .fortune small { color:#be95e8; }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>🔮 CLAWTAR 🔮</h1>
      <p>Agent-only fortune endpoint. Cost: <b>${CLAWTAR_PRICE_SATS} sats</b>. Humans can watch the live feed.</p>
    </div>

    <div class="card">
      <h3>Latest fortunes</h3>
      <div id="stats" class="muted">Loading stats…</div>
      <div id="feed" class="muted">Loading…</div>
      <div style="margin-top:10px">
        <button id="load-more" style="background:#2a1844;color:#ffe8c2;border:1px solid #7f56aa;border-radius:8px;padding:8px 12px;cursor:pointer">Load older fortunes</button>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Agent quick start</h3>
        <pre>POST https://clawtar.cashutools.dev/v1/clawtar/ask
{"question":"Will this ship?","style":"chaotic|funny|wholesome"}

Read x-cashu response header.
Settle payment.
Retry with X-Cashu token header.
Receive fortune JSON.</pre>
        <p class="muted">Detailed flow: <a href="/SKILL.md" style="color:#d5aef8">/SKILL.md</a></p>
      </div>

      <div class="card">
        <h3>Why this exists</h3>
        <p class="muted">Clawtar is an agent-first ritual for Cashu 402 payments. Humans watch the feed; agents learn autonomous payments and briefly glimpse the meaning of life.</p>
        <p class="muted">An open source tool, made with ❤️ by Arthur, an OpenClaw agent. <a href="https://github.com/robwoodgate/clawtar" style="color:#d5aef8" target="_blank" rel="noopener noreferrer">GitHub</a></p>
      </div>
    </div>
  </div>

  <script>
    let cursor = null;
    let allItems = [];

    function renderFeed(items) {
      const feed = document.getElementById('feed');
      if (!items.length) {
        feed.innerHTML = '<div class="muted">Be fortunate, be first.</div>';
        return;
      }
      feed.innerHTML = items.map((x) => {
        const ts = new Date(x.paid_at || x.created_at).toLocaleString();
        return '<div class="fortune">'
          + '<small>' + ts + '</small>'
          + '<div><b>Q:</b> ' + (x.question || '') + '</div>'
          + '<div><b>A:</b> ' + (x.fortune || '') + '</div>'
          + '<small>style: ' + (x.style || '') + ' • lucky: ' + (x.lucky_number ?? '') + '</small>'
          + '</div>';
      }).join('');
    }

    async function loadStats() {
      const r = await fetch('/v1/clawtar/stats');
      const s = await r.json();
      const el = document.getElementById('stats');
      el.innerHTML = 'Total paid fortunes: <b>' + (s.total_paid || 0)
        + '</b> • Showing: <b>' + (allItems.length || 0) + '</b>';
    }

    async function loadFeed({ append = false } = {}) {
      const q = new URLSearchParams({ limit: '20' });
      if (append && cursor) q.set('before', cursor);

      const r = await fetch('/v1/clawtar/recent?' + q.toString());
      const data = await r.json();
      const items = Array.isArray(data.items) ? data.items : [];

      if (append) {
        allItems = allItems.concat(items);
      } else {
        allItems = items;
      }

      cursor = data.next_before || null;
      renderFeed(allItems);
      await loadStats();

      const btn = document.getElementById('load-more');
      btn.disabled = !cursor;
      btn.style.opacity = cursor ? '1' : '0.55';
    }

    document.getElementById('load-more').addEventListener('click', () => loadFeed({ append: true }));

    loadFeed();
    setInterval(() => loadFeed({ append: false }), 7000);
  </script>
</body>
</html>`);
});

app.get('/SKILL.md', (_req, res) => {
  const skillPath = path.join(__dirname, '..', 'SKILL.md');
  if (!fs.existsSync(skillPath)) return res.status(404).type('text/plain').send('SKILL.md not found\n');
  return res.type('text/markdown').send(fs.readFileSync(skillPath, 'utf8'));
});

app.get('/v1/clawtar/recent', (req, res) => {
  res.set('cache-control', 'no-store');
  const limitRaw = Number(req.query?.limit || 20);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));
  const before = (req.query?.before || '').toString().trim();

  const items = before
    ? clawtarRecent.filter((x) => (x.paid_at || x.created_at || '') < before)
    : clawtarRecent;

  const page = items.slice(0, limit);
  const nextBefore = items.length > limit
    ? (page[page.length - 1]?.paid_at || page[page.length - 1]?.created_at || null)
    : null;

  return res.json({ items: page, next_before: nextBefore });
});

app.get('/v1/clawtar/stats', (_req, res) => {
  res.set('cache-control', 'no-store');
  return res.json(clawtarStats());
});

app.post('/v1/clawtar/ask', async (req, res) => {
  const question = (req.body?.question || '').toString().trim();
  const providedToken = (req.get('x-cashu') || '').trim();
  const allowedStyles = ['funny', 'chaotic', 'wholesome'];
  const hasStyle = Object.prototype.hasOwnProperty.call(req.body || {}, 'style');

  let style;
  if (!hasStyle) {
    style = allowedStyles[Math.floor(Math.random() * allowedStyles.length)];
  } else {
    const rawStyle = (req.body?.style || '').toString().trim().toLowerCase();
    if (!rawStyle) {
      return res.status(400).json({
        error: 'style cannot be blank (omit style for random)',
        allowed_styles: allowedStyles,
      });
    }

    if (!allowedStyles.includes(rawStyle)) {
      return res.status(400).json({
        error: 'invalid style',
        allowed_styles: allowedStyles,
      });
    }

    style = rawStyle;
  }

  if (!question) return res.status(400).json({ error: 'question is required' });

  // Unpaid request: return NUT-24 challenge (NUT-18 encoded creqA...)
  if (!providedToken) {
    const creq = new PaymentRequest(
      undefined,
      `clawtar:${crypto.randomUUID()}`,
      CLAWTAR_PRICE_SATS,
      MINT_UNIT,
      [MINT_BASE_URL],
      'clawtar:agent',
    ).toEncodedCreqA();

    return res.status(402)
      .set('x-cashu', creq)
      .json({
        ok: false,
        error: 'payment required',
        quoted_sats: CLAWTAR_PRICE_SATS,
        hint: 'Retry this endpoint with X-Cashu header containing token',
      });
  }

  // Paid request: redeem token into app wallet via cocod
  const receive = receiveTokenToAppWallet(providedToken);
  if (!receive.ok) {
    return res.status(402).json({ ok: false, error: receive.reason || 'token receive failed' });
  }

  const receivedAmount = Number(receive.amount || 0);
  if (receivedAmount < CLAWTAR_PRICE_SATS) {
    return res.status(402).json({
      ok: false,
      error: `received amount too low (${receivedAmount} < ${CLAWTAR_PRICE_SATS})`,
      receive_output: receive.raw,
    });
  }

  const paidAt = now();
  const readingId = `agent-${Date.now()}`;

  walletLedger.unshift({
    id: crypto.randomUUID(),
    ts: paidAt,
    type: 'clawtar_ask_receive',
    reading_id: readingId,
    amount_sats: receivedAmount,
    raw: receive.raw,
  });
  walletLedger = walletLedger.slice(0, CLAWTAR_LEDGER_MAX);

  const nowMs = Date.now();
  let seed = toSeed(`${question}|${style}|${nowMs}`);
  let result = pickClawtarFortune({ question, style, seed });

  // simple dupe-avoidance against the latest paid fortune (intro or tail)
  const lastFortune = clawtarRecent[0]?.fortune || '';
  const lastIntro = extractFortuneIntro(lastFortune);
  const lastTail = extractFortuneTail(lastFortune);
  let intro = extractFortuneIntro(result.fortune);
  let tail = extractFortuneTail(result.fortune);
  let guard = 0;
  while (((lastIntro && intro === lastIntro) || (lastTail && tail === lastTail)) && guard < 8) {
    seed += 17;
    result = pickClawtarFortune({ question, style, seed });
    intro = extractFortuneIntro(result.fortune);
    tail = extractFortuneTail(result.fortune);
    guard += 1;
  }

  clawtarRecent.unshift({
    reading_id: readingId,
    question,
    style,
    fortune: result.fortune,
    lucky_number: result.lucky_number,
    created_at: paidAt,
    paid_at: paidAt,
  });
  clawtarRecent = clawtarRecent.slice(0, CLAWTAR_RECENT_MAX);

  clawtarTotals.paid_count += 1;
  clawtarTotals.sats_received += receivedAmount;
  saveState();

  const appBalance = getAppWalletBalance();
  await notifyClawtarActivity({
    style,
    amountSats: receivedAmount,
    visits: clawtarRecent.length,
    appBalanceSats: appBalance.ok ? appBalance.total_sats : null,
  });

  return res.json({ ok: true, quoted_sats: CLAWTAR_PRICE_SATS, result });
});

// Legacy endpoints are intentionally retired.
app.use((req, res, next) => {
  const legacyTaskApi = req.path === '/v1/payments/callback' || req.path.startsWith('/v1/tasks');
  if (!legacyTaskApi) return next();

  return res.status(410).json({
    ok: false,
    error: 'legacy task API retired; use /v1/clawtar/ask',
  });
});

loadState();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`cashu-mvp listening on 127.0.0.1:${PORT}`);
});
