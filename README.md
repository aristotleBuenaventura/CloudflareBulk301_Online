# Bulk301 Online

React admin UI + **Cloudflare Worker Cron** for automatic daily 301 redirects.

Each weekday has its own target domain. The Worker applies redirects on a schedule using a Cloudflare API token stored as a **Worker secret** (never in the browser or git).

## Architecture

```
React UI  --admin secret-->  Worker API  --CF token secret-->  Cloudflare Zones
                                   ^
                                   |
                              Cron (daily)
```

| Piece | Role |
|---|---|
| React app | Edit weekly schedule + old domains, Save, Apply now |
| Worker | Stores config in KV, runs Cron, calls Cloudflare API |
| `CLOUDFLARE_API_TOKEN` | Worker secret only — you set it locally |
| `ADMIN_SECRET` | Protects the admin UI ↔ Worker API |

## 1. Worker setup (you do the secrets)

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars
```

Edit `worker/.dev.vars` (local only, gitignored):

```env
CLOUDFLARE_API_TOKEN=your_new_token_here
ADMIN_SECRET=pick-a-long-random-password
```

**Do not paste tokens into chat.** If a token was ever shared in chat, revoke it and create a new one.

Create KV (requires Cloudflare login once):

```bash
npx wrangler login
npm run kv:create
```

Copy the printed namespace IDs into `worker/wrangler.toml` under `[[kv_namespaces]]`.

Local Worker:

```bash
npm run dev
# → http://127.0.0.1:8787
```

## 2. React admin UI

From repo root:

```bash
npm install
cp .env.example .env
npm run dev
# → http://localhost:5173
```

Login with:
- **Worker URL:** `http://127.0.0.1:8787`
- **Admin secret:** same as `ADMIN_SECRET` in `.dev.vars`

Then:
1. Edit Mon–Sun target domains  
2. Upload / paste old domains  
3. **Save to Worker**  
4. **Apply now** (optional test) — Cron will also run daily  

## 3. Deploy Worker (livesite automation)

```bash
cd worker
npx wrangler secret put CLOUDFLARE_API_TOKEN   # paste in terminal, not chat
npx wrangler secret put ADMIN_SECRET
npm run deploy
```

Point the UI at the Worker URL:

```env
VITE_WORKER_URL=https://bulk301-scheduler.<your-subdomain>.workers.dev
```

Rebuild/redeploy the frontend (`npm run build`) with that env set.

### Cron / editable time

Worker cron checks **every minute**. The actual daily apply time is set in the UI
(**Daily apply time** + **Timezone**), saved to KV, and can be changed anytime
without redeploying.

Default: `00:00` in `Asia/Manila`.

## Cloudflare token permissions

| Permission | Access |
|---|---|
| Zone → Zone | Read |
| Zone → Page Rules | Edit |
| Zone → Single Redirect | Edit |

Zone resources: **All zones** (or the zones you need).

## Default weekly schedule

| Day | Target |
|---|---|
| Monday | https://ga888tructiep.org |
| Tuesday | https://ga888tructiep.net |
| Wednesday | https://ga888tructiep.app |
| Thursday | https://ga888tructiep.tech |
| Friday | https://ga888tructiep.dev |
| Saturday | https://ga888tructiep.us |
| Sunday | https://ga888tructiep.biz |

## Security checklist

- [ ] Never commit `.dev.vars`, `.env`, or real tokens  
- [ ] Revoke any token that was pasted into chat  
- [ ] Use a strong `ADMIN_SECRET`  
- [ ] Cloudflare token only via `wrangler secret put` on production  
