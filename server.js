/**
 * MARCUS GANZO — AI teammate for SMB Virtual Staffing
 * ----------------------------------------------------
 * Features (v1):
 *  1. Q&A teammate  — @mention Marcus anywhere he's invited, replies in Taglish w/ persona
 *  2. Hourly check-ins — 9:30PM–4:30AM PHT, AI-generated questions from the weekly topics
 *  3. Points        — Marcus scores each check-in reply 1–3 with judgment; points accumulate
 *  4. Leaderboard   — "@Marcus Ganzo leaderboard" on demand + auto-post Friday 4:45AM PHT
 *  5. Admin page    — /admin to set Mon–Fri topics for the week (password protected)
 *  6. BINGO points integration — secured endpoints so the BINGO app can check/spend a
 *     player's points to buy an extra card. See MIGRATION.sql for the required Supabase setup.
 *  7. Nightly points recap — posted to the PM GC every shift end (not just Fridays), showing
 *     who earned what TONIGHT plus the running overall leaderboard.
 *
 * Storage:
 *  - Weekly topics + check-in questions: Supabase, one JSONB row (marcus_db table).
 *  - Points: dedicated `marcus_points` table (one row per Slack user), updated atomically
 *    via Postgres functions so concurrent check-in replies can never clobber each other.
 *    (This replaces the old single-JSONB-blob points storage, which had a real race: two
 *    people replying close together could load-modify-save over each other and silently
 *    drop one person's points. If you were on the old server.js and people said "I answered
 *    but got no points," this was almost certainly why — the new table+RPC design makes
 *    every point award a single atomic DB operation, so it can't happen anymore.)
 */

const { App, ExpressReceiver } = require("@slack/bolt");
const cron = require("node-cron");

// ---------- ENV ----------
const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  GEMINI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_PASSWORD,
  BINGO_INTEGRATION_SECRET, // shared secret with the BINGO backend — required for /api/points/*
  CHECKIN_CHANNEL = "C0A71RYLS9E", // #0-project-manager-corner
  BANTER_RATE = 0.35, // fraction of replies that get a full Gemini-powered witty response
  PORT = 3000,
} = process.env;

const TZ = "Asia/Manila";

// ---------- SLACK APP (Bolt with Express receiver so we can add /admin) ----------
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver });
const express = receiver.app; // underlying express instance
const expressLib = require("express");
express.use(expressLib.urlencoded({ extended: true }));
// NOTE: we deliberately do NOT add a global express.json() here — Bolt's own
// receiver needs the raw request body to verify Slack's signature. json()
// is applied only to the specific new routes below that need it (POST /api/points/spend).

// ---------- SUPABASE STORAGE (weekly topics + check-in questions) ----------
// One table, one row holding app state as JSONB (simple + atomic enough for this volume).
// SQL to run once in Supabase SQL editor (if not already done):
//   create table marcus_db (id int primary key, data jsonb not null default '{}');
//   insert into marcus_db (id, data) values (1, '{}');
const SB_URL = (SUPABASE_URL || "").trim().replace(/\/+$/, ""); // tolerate trailing slashes/spaces
const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};
const EMPTY = { topics: {}, checkins: {} };

async function loadDB() {
  const r = await fetch(`${SB_URL}/rest/v1/marcus_db?id=eq.1&select=data`, { headers: SB_HEADERS });
  if (!r.ok) { console.error("Supabase load failed", r.status, await r.text()); return { ...EMPTY }; }
  const rows = await r.json();
  return { ...EMPTY, ...(rows[0]?.data || {}) };
}
async function saveDB(db) {
  const r = await fetch(`${SB_URL}/rest/v1/marcus_db?id=eq.1`, {
    method: "PATCH",
    headers: SB_HEADERS,
    body: JSON.stringify({ data: db }),
  });
  if (!r.ok) console.error("Supabase save failed", r.status, await r.text());
}

// ---------- SUPABASE STORAGE (points — dedicated table, atomic RPC calls) ----------
async function getPointsRow(userId) {
  const r = await fetch(`${SB_URL}/rest/v1/marcus_points?user_id=eq.${encodeURIComponent(userId)}&select=*`, { headers: SB_HEADERS });
  if (!r.ok) { console.error("Supabase getPointsRow failed", r.status, await r.text()); return null; }
  const rows = await r.json();
  return rows[0] || null;
}
async function getLeaderboardRows() {
  const r = await fetch(`${SB_URL}/rest/v1/marcus_points?select=*&order=total.desc&limit=15`, { headers: SB_HEADERS });
  if (!r.ok) { console.error("Supabase getLeaderboardRows failed", r.status, await r.text()); return []; }
  return r.json();
}
// All rows, unsorted/unlimited — used to build the nightly recap (needs to scan every
// user's `history` array for tonight's entries, not just the top 15 by total).
async function getAllPointsRows() {
  const r = await fetch(`${SB_URL}/rest/v1/marcus_points?select=*`, { headers: SB_HEADERS });
  if (!r.ok) { console.error("Supabase getAllPointsRows failed", r.status, await r.text()); return []; }
  return r.json();
}
async function addPointAtomic(userId, name, score, ts, when) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/marcus_add_point`, {
    method: "POST",
    headers: SB_HEADERS,
    body: JSON.stringify({ p_user_id: userId, p_name: name, p_score: score, p_ts: ts, p_when: when }),
  });
  if (!r.ok) console.error("Supabase addPointAtomic failed", r.status, await r.text());
}
async function getBalance(userId) {
  const row = await getPointsRow(userId);
  return row?.total ?? 0;
}
// Returns { success, newTotal }
async function spendPointsAtomic(userId, amount) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/marcus_spend_points`, {
    method: "POST",
    headers: SB_HEADERS,
    body: JSON.stringify({ p_user_id: userId, p_amount: amount }),
  });
  if (!r.ok) {
    console.error("Supabase spendPointsAtomic failed", r.status, await r.text());
    return { success: false, newTotal: await getBalance(userId) };
  }
  const rows = await r.json();
  const row = rows[0] || { success: false, new_total: await getBalance(userId) };
  return { success: !!row.success, newTotal: row.new_total };
}

// ---------- GEMINI (free tier) ----------
async function askAI(system, user, maxTokens = 800) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    const j = await r.json();
    const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n");
    if (!text) { console.error("Gemini error:", JSON.stringify(j).slice(0, 500)); return null; }
    return text;
  } catch (e) {
    // FIX: network hiccups on the Gemini fetch used to throw uncaught and could take
    // down the process. Now we just return null and callers fall back to their
    // existing heuristics/fallback text — same behavior as a "Gemini said nothing" case.
    console.error("askAI network error:", e.message);
    return null;
  }
}

const PERSONA = `You are Marcus Ganzo, the AI teammate of SMB Virtual Staffing (SMB VS), a Philippines-based
virtual staffing company. The team works overnight (graveyard shift, PHT) and are called "Bayani".
Reply in Taglish when spoken to in Taglish, otherwise English. Be warm, witty, encouraging, and concise.
Never invent client data. Keep replies Slack-friendly (short paragraphs, occasional emoji, use *bold* not markdown headers).`;

// ---------- HELPERS ----------
const PHT_DAY = () =>
  new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: TZ }).toLowerCase().slice(0, 3);
// NOTE: check-ins from 9:30PM run into the NEXT calendar day after midnight.
// The "work night" belongs to the day the shift STARTED, so before 12PM PHT we roll back one day.
function workNightDay() {
  const now = new Date();
  const hourPHT = Number(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: TZ }));
  const d = new Date(now);
  if (hourPHT < 12) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: TZ }).toLowerCase().slice(0, 3);
}
// Start-of-tonight's-shift as a JS Date (9:00PM PHT on the work night's calendar day, PHT),
// used to filter each player's `history` down to just tonight's entries for the recap.
function shiftStartDate() {
  const now = new Date();
  const hourPHT = Number(now.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: TZ }));
  const d = new Date(now);
  if (hourPHT < 12) d.setDate(d.getDate() - 1); // same "which calendar day owns this shift" logic as workNightDay()
  // Build 9:00PM PHT on that date. PHT is UTC+8, no DST.
  const y = Number(d.toLocaleString("en-US", { year: "numeric", timeZone: TZ }));
  const mo = Number(d.toLocaleString("en-US", { month: "2-digit", timeZone: TZ }));
  const da = Number(d.toLocaleString("en-US", { day: "2-digit", timeZone: TZ }));
  return new Date(Date.UTC(y, mo - 1, da, 21 - 8, 0, 0)); // 21:00 PHT = 13:00 UTC
}

async function post(channel, text, thread_ts) {
  return app.client.chat.postMessage({ channel, text, thread_ts });
}

// ---------- 1) HOURLY CHECK-IN ----------
async function postCheckin() {
  const db = await loadDB();
  const day = workNightDay();
  const topic = db.topics[day];
  if (!topic) { console.log(`No topic set for ${day}, skipping check-in.`); return; }

  // Try Gemini up to 2x; if it still fails, use a fallback question so the hour NEVER goes silent
  let q = null;
  for (let attempt = 1; attempt <= 2 && !q; attempt++) {
    const raw = await askAI(
      PERSONA,
      `Generate ONE engagement check-in question for the overnight team based on tonight's topic: "${topic}".
Give exactly 3 answer options (A, B, C). Staff must pick one AND explain why.
Respond ONLY as JSON: {"question":"...","options":["...","...","..."]} — no markdown fences.`,
      500
    );
    if (!raw) { console.error(`Question gen attempt ${attempt} failed (Gemini)`); continue; }
    try {
      const m = raw.match(/\{[\s\S]*\}/); // grab the JSON object even if wrapped in extra text
      const parsed = JSON.parse((m ? m[0] : raw).replace(/```json|```/g, "").trim());
      if (parsed.question && parsed.options?.length === 3) q = parsed;
      else console.error(`Question gen attempt ${attempt}: bad shape`, raw.slice(0, 200));
    } catch { console.error(`Question gen attempt ${attempt}: bad JSON`, raw.slice(0, 200)); }
  }
  if (!q) {
    console.error("Using fallback question (Gemini unavailable)");
    q = {
      question: `Tungkol sa "${topic}" — alin dito ang pinaka-relate mo ngayong shift?`,
      options: ["Solid ako dito, may example pa ako", "Medyo challenge pa sa akin ito", "May tanong ako tungkol dito"],
    };
  }

  const text =
    `🕐 *Hourly Check-in!* Topic: _${topic}_\n\n*${q.question}*\n` +
    `🅰️ ${q.options[0]}\n🅱️ ${q.options[1]}\n🅲 ${q.options[2]}\n\n` +
    `Reply *in this thread* with your pick + why. May points ang magagandang sagot! 😉`;

  const res = await post(CHECKIN_CHANNEL, text);
  db.checkins[res.ts] = { question: q.question, options: q.options, topic, when: new Date().toISOString() };
  await saveDB(db);
}

// ---------- 2) SCORING replies in check-in threads ----------
// Latest check-in within the last 65 minutes (so top-level replies count too)
function latestActiveCheckin(db) {
  const entries = Object.entries(db.checkins).sort((a, b) => Number(b[0]) - Number(a[0]));
  if (!entries.length) return null;
  const [ts, c] = entries[0];
  return (Date.now() - Number(ts) * 1000 < 65 * 60 * 1000) ? { ts, ...c } : null;
}

app.message(async ({ message }) => {
  try {
    if (message.bot_id || message.subtype || message.channel !== CHECKIN_CHANNEL) return;
    // FIX: previously only skipped messages where the mention was the FIRST token
    // (/^\s*<@/). A message like "quick q for you @Marcus Ganzo" has the mention
    // mid-string, so it slipped through and got double-processed here AND in
    // app_mention (Q&A + a bogus check-in score). Now matches a mention anywhere.
    if (message.text && /<@[A-Z0-9]+>/i.test(message.text)) return; // @mentions handled elsewhere (app_mention event)
    const db = await loadDB();
    // Accept BOTH: replies in a check-in thread, OR top-level messages while a check-in is active
    let checkinTs = message.thread_ts && db.checkins[message.thread_ts] ? message.thread_ts : null;
    if (!checkinTs) {
      const active = latestActiveCheckin(db);
      if (active && !message.thread_ts) checkinTs = active.ts;
    }
    if (!checkinTs) return;
    const checkin = db.checkins[checkinTs];

    const existingPoints = await getPointsRow(message.user);
    const already = existingPoints?.history?.some(h => h.ts === checkinTs);
    if (already) return; // one score per check-in per person

    // QUOTA SAVER: only ~BANTER_RATE of replies get a Gemini-powered witty response.
    // The rest get a fast heuristic score + emoji reaction (zero API cost).
    const useAI = Math.random() < Number(BANTER_RATE);
    let score, comment = null;
    if (useAI) {
      const raw = await askAI(
        PERSONA,
        `A team member answered a check-in.\nQuestion: ${checkin.question}\nOptions: ${checkin.options.join(" | ")}\nTheir answer: "${message.text}"\n\n` +
        `Score it 1-3: 1 = barely an answer / no reasoning; 2 = decent pick with a short reason; 3 = thoughtful, specific reasoning.\n` +
        `Then write a "comment": a witty Taglish reaction that ALSO engages them like a real teammate — react to their specific reasoning, ` +
        `and often end with a short playful follow-up question or friendly challenge (banter). 1-2 sentences max.\n` +
        `Respond ONLY as JSON: {"score":N,"comment":"..."} — no markdown fences.`,
        400
      );
      try {
        const j = JSON.parse(raw.replace(/```json|```/g, "").trim());
        score = Math.max(1, Math.min(3, Number(j.score) || 1));
        comment = j.comment;
      } catch { /* fall through to heuristic */ }
    }
    if (!score) {
      // Heuristic: picked an option + explained = more words, better score
      const words = (message.text || "").trim().split(/\s+/).length;
      score = words >= 25 ? 3 : words >= 8 ? 2 : 1;
    }

    const info = await app.client.users.info({ user: message.user });
    const name = info.user?.profile?.display_name || info.user?.real_name || message.user;

    await addPointAtomic(message.user, name, score, checkinTs, new Date().toISOString());

    if (comment) {
      const stars = "⭐".repeat(score);
      // Reply where they answered: their thread if threaded, else the check-in's thread (keeps channel tidy)
      await post(message.channel, `${stars} *+${score} points* para kay *${name}*! ${comment}`, message.thread_ts || checkinTs);
    } else {
      // Quiet acknowledgment: emoji reactions only (star + score number), no API cost
      const num = ["one", "two", "three"][score - 1];
      try {
        await app.client.reactions.add({ channel: message.channel, timestamp: message.ts, name: "star" });
        await app.client.reactions.add({ channel: message.channel, timestamp: message.ts, name: num });
      } catch (e) { console.error("reaction failed (add reactions:write scope?)", e.data?.error || e); }
    }
  } catch (e) { console.error("scoring error", e); }
});

// ---------- 3) LEADERBOARD ----------
// Takes rows straight from marcus_points (already sorted+limited by getLeaderboardRows).
function leaderboardText(rows) {
  if (!rows.length) return "Wala pang points sa leaderboard — sagot na kayo sa next check-in! 😄";
  const medals = ["🥇", "🥈", "🥉"];
  return "*🏆 Marcus Ganzo Check-in Leaderboard*\n" +
    rows.map((r, i) => `${medals[i] || `${i + 1}.`} *${r.name}* — ${r.total} pts`).join("\n");
}

// ---------- 3b) NIGHTLY RECAP (posted every shift end, not just Fridays) ----------
// Shows who earned what TONIGHT (from shiftStartDate() to now) plus the running overall total.
async function nightlyRecapText() {
  const rows = await getAllPointsRows();
  const cutoff = shiftStartDate();
  const tonight = rows
    .map(r => {
      const earnedTonight = (r.history || [])
        .filter(h => new Date(h.when) >= cutoff)
        .reduce((sum, h) => sum + (h.score || 0), 0);
      return { name: r.name, total: r.total, earnedTonight };
    })
    .filter(r => r.earnedTonight > 0)
    .sort((a, b) => b.earnedTonight - a.earnedTonight);

  if (!tonight.length) {
    return "*📋 Tonight's Recap*\nWalang sumagot sa check-ins ngayong shift — sana next time, may points kayo! 😅";
  }

  const lines = tonight.map(r => `• *${r.name}* — +${r.earnedTonight} pts tonight (${r.total} total)`).join("\n");
  const overallTop3 = [...rows].sort((a, b) => b.total - a.total).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const topLine = overallTop3.length
    ? "\n\n*Overall standings:*\n" + overallTop3.map((r, i) => `${medals[i]} ${r.name} — ${r.total} pts`).join("\n")
    : "";
  return `*📋 Tonight's Recap*\n${lines}${topLine}`;
}

// ---------- 4) @MENTIONS: commands + Q&A ----------
app.event("app_mention", async ({ event }) => {
  try {
    const text = (event.text || "").toLowerCase();
    if (text.includes("leaderboard")) {
      return post(event.channel, leaderboardText(await getLeaderboardRows()), event.thread_ts);
    }
    if (text.includes("recap")) {
      return post(event.channel, await nightlyRecapText(), event.thread_ts);
    }
    // general Q&A — pull recent channel context so Marcus can answer "summarize the thread" etc.
    let context = "";
    try {
      const hist = await app.client.conversations.history({ channel: event.channel, limit: 30 });
      context = hist.messages.reverse().map(m => `${m.user || "bot"}: ${m.text}`).join("\n").slice(-6000);
    } catch { /* not in channel history scope? proceed without */ }

    const reply = await askAI(
      PERSONA,
      `Recent channel messages for context:\n${context}\n\nThe user mentioned you and said: "${event.text}"\nReply helpfully as Marcus Ganzo.`,
      900
    );
    await post(event.channel, reply || "Pasensya na, nagka-aberya ako saglit. Try mo ulit? 🙏", event.thread_ts || event.ts);
  } catch (e) { console.error("mention error", e); }
});

// ---------- 5) OPENER / CLOSER + SCHEDULES (all PHT) ----------
async function opener() {
  const db = await loadDB();
  const topic = db.topics[workNightDay()] || "our amazing overnight hustle";
  const msg = await askAI(PERSONA,
    `Write tonight's opening message from the PM to the overnight Bayani team: a warm good morning
(their shift is starting), one short motivational quote about work, and mention tonight's check-in topic: "${topic}".
Taglish, witty, max 4 lines.`, 400);
  if (msg) await post(CHECKIN_CHANNEL, `☀️ ${msg}`);
}
async function closer() {
  const msg = await askAI(PERSONA,
    `Write the end-of-shift message: "ingat sa pag-uwi" for in-office Bayani + thank you to the WFH team.
Taglish, warm and witty, max 3 lines.`, 300);
  if (msg) await post(CHECKIN_CHANNEL, `🌅 ${msg}`);
}

// Opener 9:15PM; check-ins 9:30PM, 10:30 ... 11:30PM then 12:30–4:30AM;
// nightly recap 4:45AM (every shift, not just Fridays); closer 4:50AM.
cron.schedule("15 21 * * 1-5", opener, { timezone: TZ });
cron.schedule("30 21-23 * * 1-5", postCheckin, { timezone: TZ });
cron.schedule("30 0-4 * * 2-6", postCheckin, { timezone: TZ });   // after midnight = next calendar day
cron.schedule("45 4 * * 2-6", async () => post(CHECKIN_CHANNEL, await nightlyRecapText()), { timezone: TZ });
cron.schedule("50 4 * * 2-6", closer, { timezone: TZ });

// ---------- 6) ADMIN PAGE (weekly topics) ----------
const DAYS = [["mon","Monday"],["tue","Tuesday"],["wed","Wednesday"],["thu","Thursday"],["fri","Friday"]];
express.get("/admin", async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.send(`<form>Password: <input name="pw" type="password"><button>Enter</button></form>`);
  const db = await loadDB();
  res.send(`<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto">
  <h2>🤖 Marcus Ganzo — Weekly Topics</h2>
  <p>Set once, runs the whole week (check-ins skip days with no topic).</p>
  <form method="POST" action="/admin?pw=${encodeURIComponent(req.query.pw)}">
  ${DAYS.map(([k,label]) => `<p><b>${label}</b><br><input name="${k}" value="${(db.topics[k]||"").replace(/"/g,"&quot;")}" style="width:100%;padding:8px"></p>`).join("")}
  <button style="padding:10px 20px">Save week</button></form>
  <p><a href="/admin/leaderboard?pw=${encodeURIComponent(req.query.pw)}">View leaderboard →</a></p>
  </body></html>`);
});
express.post("/admin", async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send("Nope.");
  const db = await loadDB();
  for (const [k] of DAYS) db.topics[k] = (req.body[k] || "").trim();
  await saveDB(db);
  res.redirect(`/admin?pw=${encodeURIComponent(req.query.pw)}`);
});
express.get("/admin/leaderboard", async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send("Nope.");
  res.send(`<pre style="font-size:16px;margin:40px">${leaderboardText(await getLeaderboardRows()).replace(/\*/g, "")}</pre>`);
});

// TESTING ONLY (2026-07-18): manually fire an hourly check-in right now, so you can
// verify the whole points flow (question posts to the channel, you reply, points get
// scored) without waiting for the real 9:30PM-4:30AM PHT schedule. Password-protected,
// same as /admin. Visit this URL in your browser: /admin/test-checkin?pw=YOUR_PASSWORD
express.get("/admin/test-checkin", async (req, res) => {
  if (req.query.pw !== ADMIN_PASSWORD) return res.status(403).send("Nope.");
  try {
    await postCheckin();
    res.send("Check-in posted to the channel — go reply to it there, then revisit /admin/leaderboard or @mention Marcus with 'recap' to see the points land.");
  } catch (e) {
    res.status(500).send("Failed: " + e.message);
  }
});
express.get("/", (_, res) => res.send("Marcus Ganzo is awake. 🫡")); // Render health check

// ---------- 7) BINGO POINTS INTEGRATION (server-to-server only) ----------
// The BINGO backend calls these two routes to check/spend a player's points when they
// buy an extra card. Protected by a shared secret (BINGO_INTEGRATION_SECRET env var) —
// never expose this secret or these routes to a browser. The BINGO backend holds the
// secret server-side and calls these directly, not through the BINGO frontend.
function requireBingoAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  if (!BINGO_INTEGRATION_SECRET || auth !== `Bearer ${BINGO_INTEGRATION_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// GET /api/points/balance?userId=<slack user id>
express.get("/api/points/balance", requireBingoAuth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const total = await getBalance(userId);
    res.json({ userId, total });
  } catch (e) {
    console.error("[/api/points/balance] failed:", e);
    res.status(500).json({ error: String(e.message) });
  }
});

// POST /api/points/spend  { userId, amount } — atomic, fails safely if not enough points
express.post("/api/points/spend", expressLib.json(), requireBingoAuth, async (req, res) => {
  try {
    const { userId, amount } = req.body || {};
    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) return res.status(400).json({ error: "userId and a positive amount are required" });
    const result = await spendPointsAtomic(userId, amt);
    res.json(result); // { success, newTotal }
  } catch (e) {
    console.error("[/api/points/spend] failed:", e);
    res.status(500).json({ error: String(e.message) });
  }
});

// ---------- START ----------
(async () => {
  await app.start(PORT);
  console.log(`⚡ Marcus Ganzo running on port ${PORT} (${TZ})`);
  // Startup self-test: verify Supabase connection & show what's stored
  const db = await loadDB();
  const topicDays = Object.keys(db.topics).filter(k => db.topics[k]);
  const leaderboardRows = await getLeaderboardRows();
  console.log(`🗄️ Supabase check: topics set for [${topicDays.join(", ") || "NONE"}], ${leaderboardRows.length} players on leaderboard (top 15)`);
  if (!BINGO_INTEGRATION_SECRET) console.warn("⚠️ BINGO_INTEGRATION_SECRET not set — /api/points/* routes will reject all requests.");
})();
