# Marcus Ganzo 🤖 — SMB VS AI Teammate

Q&A teammate + hourly check-ins (9:30PM–4:30AM PHT) + points & leaderboard. Runs on Render, brain by Gemini free tier, storage on Supabase (free).

## Setup — step by step

### Step 1 — Create the Slack app
1. Go to **api.slack.com/apps → Create New App → From scratch**
2. Name: `Marcus Ganzo`, workspace: SMB VS
3. **OAuth & Permissions → Bot Token Scopes**, add:
   - `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `users:read`
4. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)
5. **Basic Information** → copy the **Signing Secret**

### Step 2 — Get a FREE Gemini API key
1. Go to **aistudio.google.com** → sign in with any Google account
2. **Get API key** → Create API key → copy it (new keys start with `AQ.`, older ones `AIza` — both work with this app)
3. Free tier limits (as of mid-2026) comfortably cover hourly check-ins + scoring for ~25 agents

### Step 3 — Set up Supabase storage
1. supabase.com → your existing account → **New project** (free tier) — or reuse a project
2. **SQL Editor** → run:
   ```sql
   create table marcus_db (id int primary key, data jsonb not null default '{}');
   insert into marcus_db (id, data) values (1, '{}');
   ```
3. **Settings → API** → copy the **Project URL** and the **service_role** key (the secret one, NOT anon)

### Step 4 — Push this repo to GitHub (PMRendy account)

### Step 5 — Deploy on Render
1. New → **Web Service** → connect the repo
2. Build command: `npm install` · Start command: `npm start`
3. Add Environment Variables from `.env.example` (never hardcode — GitHub secret scanning will revoke them)
4. Deploy → note your URL, e.g. `https://marcus-ganzo.onrender.com`

### Step 6 — Point Slack at Render
1. Slack app → **Event Subscriptions** → toggle ON
2. Request URL: `https://YOUR-RENDER-URL/slack/events` (must show "Verified")
3. **Subscribe to bot events**: `app_mention`, `message.channels`, `message.groups`
4. Save → reinstall app if prompted

### Step 7 — Invite Marcus
- In any channel: `/invite @Marcus Ganzo`
- Required: invite him to **#0-project-manager-corner** (check-in home)

### Step 8 — Set the week's topics
- Open `https://YOUR-RENDER-URL/admin` → enter admin password → fill Monday–Friday topics → Save

## How it works nightly
| Time (PHT) | What Marcus does |
|---|---|
| 9:15 PM | Good-morning opener + motivational quote |
| 9:30 PM – 4:30 AM | Hourly check-in question (3 options, reply in thread) |
| on each reply | Scores 1–3 ⭐ with a witty comment, adds to points |
| 4:50 AM | "Ingat sa pag-uwi" closer |
| Fri shift end 4:45 AM | Auto leaderboard post |

Anytime: `@Marcus Ganzo leaderboard` · `@Marcus Ganzo <any question>`

## Notes
- No topic set for a day = check-ins skip that day (no error)
- One score per person per check-in; points never deducted
- Render free tier sleeps after inactivity — use a cron ping service (e.g. cron-job.org hitting `/`) to keep Marcus awake overnight, or use a paid instance
