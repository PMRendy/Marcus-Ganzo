/**
 * MARCUS GANZO — AI teammate for SMB Virtual Staffing
 * ----------------------------------------------------
 * Features (v1):
 *  1. Q&A teammate  — @mention Marcus anywhere he's invited, replies in Taglish w/ persona
 *  2. Hourly check-ins — 9:30PM–4:30AM PHT, AI-generated questions from the weekly topics
 *  3. Points        — Marcus scores each check-in reply 1–3 with judgment; points accumulate
 *  4. Leaderboard   — "@Marcus Ganzo leaderboard" on demand + auto-post Friday 4:45AM PHT
 *  5. Admin page    — /admin to set Mon–Fri topics for the week (password protected)
 *
 * Storage: Supabase (one JSONB row). Structure:
 *  { topics: { mon:"", tue:"", ... }, points: { "U123": { name, total, history:[...] } },
 *    checkins: { "<message_ts>": { question, options, date } } }
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
  CHECKIN_CHANNEL = "C0A71RYLS9E", // #0-project-manager-corner
  PORT = 3000,
} = process.env;

const TZ = "Asia/Manila";

// ---------- SLACK APP (Bolt with Express receiver so we can add /admin) ----------
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver });
const express = receiver.app; // underlying express instance
express.use(require("express").urlencoded({ extended: true }));

// ---------- SUPABASE STORAGE ----------
// One table, one row holding the whole app state as JSONB (simple + atomic enough for this volume).
// SQL to run once in Supabase SQL editor:
//   create table marcus_db (id int primary key, data jsonb not null default '{}');
//   insert into marcus_db (id, data) values (1, '{}');
const SB_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};
const EMPTY = { topics: {}, points: {}, checkins: {} };

async function loadDB() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/marcus_db?id=eq.1&select=data`, { headers: SB_HEADERS });
  if (!r.ok) { console.error("Supabase load failed", r.status, await r.text()); return { ...EMPTY }; }
  const rows = await r.json();
  return { ...EMPTY, ...(rows[0]?.data || {}) };
}
async function saveDB(db) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/marcus_db?id=eq.1`, {
    method: "PATCH",
    headers: SB_HEADERS,
    body: JSON.stringify({ data: db }),
  });
  if (!r.ok) console.error("Supabase save failed", r.status, await r.text());
}

// ---------- GEMINI (free tier) ----------
async function askAI(system, user, maxTokens = 800) {
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

async function post(channel, text, thread_ts) {
  return app.client.chat.postMessage({ channel, text, thread_ts });
}

// ---------- 1) HOURLY CHECK-IN ----------
async function postCheckin() {
  const db = await loadDB();
  const day = workNightDay();
  const topic = db.topics[day];
  if (!topic) { console.log(`No topic set for ${day}, skipping check-in.`); return; }

  const raw = await askAI(
    PERSONA,
    `Generate ONE engagement check-in question for the overnight team based on tonight's topic: "${topic}".
Give exactly 3 answer options (A, B, C). Staff must pick one AND explain why.
Respond ONLY as JSON: {"question":"...","options":["...","...","..."]} — no markdown fences.`,
    500
  );
  let q;
  try { q = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch { console.error("Bad question JSON:", raw); return; }

  const text =
    `🕐 *Hourly Check-in!* Topic: _${topic}_\n\n*${q.question}*\n` +
    `🅰️ ${q.options[0]}\n🅱️ ${q.options[1]}\n🅲 ${q.options[2]}\n\n` +
    `Reply *in this thread* with your pick + why. May points ang magagandang sagot! 😉`;

  const res = await post(CHECKIN_CHANNEL, text);
  db.checkins[res.ts] = { question: q.question, options: q.options, topic, when: new Date().toISOString() };
  await saveDB(db);
}

// ---------- 2) SCORING replies in check-in threads ----------
app.message(async ({ message }) => {
  try {
    if (!message.thread_ts || message.bot_id || message.channel !== CHECKIN_CHANNEL) return;
    const db = await loadDB();
    const checkin = db.checkins[message.thread_ts];
    if (!checkin) return;

    const already = db.points[message.user]?.history?.some(h => h.ts === message.thread_ts);
    if (already) return; // one score per check-in per person

    const raw = await askAI(
      PERSONA,
      `A team member answered a check-in.\nQuestion: ${checkin.question}\nOptions: ${checkin.options.join(" | ")}\nTheir answer: "${message.text}"\n\n` +
      `Score it 1-3: 1 = barely an answer / no reasoning; 2 = decent pick with a short reason; 3 = thoughtful, specific reasoning.\n` +
      `Respond ONLY as JSON: {"score":N,"comment":"one short witty Taglish reaction to their answer"} — no markdown fences.`,
      300
    );
    let s;
    try { s = JSON.parse(raw.replace(/```json|```/g, "").trim()); } catch { return; }
    const score = Math.max(1, Math.min(3, Number(s.score) || 1));

    const info = await app.client.users.info({ user: message.user });
    const name = info.user?.profile?.display_name || info.user?.real_name || message.user;

    if (!db.points[message.user]) db.points[message.user] = { name, total: 0, history: [] };
    db.points[message.user].name = name;
    db.points[message.user].total += score;
    db.points[message.user].history.push({ ts: message.thread_ts, score, when: new Date().toISOString() });
    await saveDB(db);

    const stars = "⭐".repeat(score);
    await post(message.channel, `${stars} *+${score} points* para kay *${name}*! ${s.comment}`, message.thread_ts);
  } catch (e) { console.error("scoring error", e); }
});

// ---------- 3) LEADERBOARD ----------
function leaderboardText(db) {
  const rows = Object.values(db.points).sort((a, b) => b.total - a.total).slice(0, 15);
  if (!rows.length) return "Wala pang points sa leaderboard — sagot na kayo sa next check-in! 😄";
  const medals = ["🥇", "🥈", "🥉"];
  return "*🏆 Marcus Ganzo Check-in Leaderboard*\n" +
    rows.map((r, i) => `${medals[i] || `${i + 1}.`} *${r.name}* — ${r.total} pts`).join("\n");
}

// ---------- 4) @MENTIONS: commands + Q&A ----------
app.event("app_mention", async ({ event }) => {
  try {
    const text = (event.text || "").toLowerCase();
    if (text.includes("leaderboard")) {
      const db = await loadDB();
      return post(event.channel, leaderboardText(db), event.thread_ts);
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

// Opener 9:15PM; check-ins 9:30PM, 10:30 ... 11:30PM then 12:30–4:30AM; closer 4:50AM; leaderboard Fri close
cron.schedule("15 21 * * 1-5", opener, { timezone: TZ });
cron.schedule("30 21-23 * * 1-5", postCheckin, { timezone: TZ });
cron.schedule("30 0-4 * * 2-6", postCheckin, { timezone: TZ });   // after midnight = next calendar day
cron.schedule("50 4 * * 2-6", closer, { timezone: TZ });
cron.schedule("45 4 * * 6", async () => post(CHECKIN_CHANNEL, leaderboardText(await loadDB())), { timezone: TZ }); // Sat 4:45AM = Friday shift end

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
  const db = await loadDB();
  res.send(`<pre style="font-size:16px;margin:40px">${leaderboardText(db).replace(/\*/g, "")}</pre>`);
});
express.get("/", (_, res) => res.send("Marcus Ganzo is awake. 🫡")); // Render health check

// ---------- START ----------
(async () => {
  await app.start(PORT);
  console.log(`⚡ Marcus Ganzo running on port ${PORT} (${TZ})`);
})();
