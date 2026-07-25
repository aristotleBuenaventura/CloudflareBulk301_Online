# Bulk301 Online

React admin UI + **Cloudflare Worker Cron** for automatic daily 301 redirects.

Each weekday has its own target domain. The Worker applies redirects on a schedule using a Cloudflare API token stored as a **Worker secret** (never in the browser or git).

## Architecture

```
    React UI  --HttpOnly cookie-->  Worker API  --CF token secret-->  Cloudflare Zones
         |                                 ^
      2FA / audit                          |
                                      Cron (daily)
```

| Piece | Role |
|---|---|
| React app | Schedule + domains UI (no secrets in localStorage) |
| Worker | Cookie sessions, 2FA, rate limit, KV config, Cron, CF API |
| `CLOUDFLARE_API_TOKEN` | Worker secret only — least-privilege zone redirects |
| `ADMIN_SECRET` | Bootstrap only — create/reset users & 2FA recovery (not daily login) |

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
# Leave VITE_WORKER_URL empty so `/api` is proxied to the local Worker (cookie auth)
npm run dev
# → http://localhost:5173
```

Login with:
- **Email** + **password**
- New accounts must **set up 2FA** before schedule/301 unlocks

`ADMIN_SECRET` is **not** for daily login — only for creating/resetting users (API):

```bash
curl -X POST http://127.0.0.1:8787/api/auth/upsert-user \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-strong-password","adminSecret":"YOUR_ADMIN_SECRET"}'
```

Then:
1. Sign in → complete **mandatory 2FA**
2. Edit Mon–Sun target domains  
3. Upload / paste old domains  
4. **Save settings**  
5. 301s run on schedule only  

## Security (live / public internet)

| Control | How |
|---|---|
| HttpOnly cookie session | Signed cookie; idle timeout 30m; optional IP bind |
| Email + password + mandatory 2FA | No schedule/301 until 2FA enabled |
| Fail-closed CORS/CSRF | `PUBLIC_INTERNET=true` + `ALLOWED_ORIGINS` (Origin checked) |
| Rate limit + lockout | 10 login / 15m IP; lock after 5 fails; bootstrap 5/hour |
| IP allowlist | Required for first-user bootstrap when public |
| No public registration | `/api/auth/register` disabled; upsert needs ADMIN_SECRET |
| Additional users | Existing 2FA session + ADMIN_SECRET |
| Hardened headers | CSP, HSTS (HTTPS), nosniff, frame deny, no-store |
| Strong secrets | Password 12+ letter/number; ADMIN_SECRET 16+ (no placeholders) |
| CF token least privilege | Zone Read + Page Rules/Redirect Edit only |

### Public deploy vars (`worker/wrangler.toml` or dashboard)

```toml
PUBLIC_INTERNET = "true"
ALLOWED_ORIGINS = "https://your-ui.example.com"
IP_ALLOWLIST = "YOUR.OFFICE.OR.VPN.IP"
COOKIE_SAMESITE = "None"
```

Create first user (from allowlisted IP):

```bash
curl -X POST https://YOUR-WORKER.workers.dev/api/auth/upsert-user \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"StrongPass123!","adminSecret":"YOUR_ADMIN_SECRET"}'
```

Later users: sign in (2FA) then call the same endpoint with session cookie + ADMIN_SECRET.

## 3. Deploy Worker (livesite automation)

```bash
cd worker
npx wrangler secret put CLOUDFLARE_API_TOKEN   # paste in terminal, not chat
npx wrangler secret put ADMIN_SECRET
npm run deploy
```

Point the UI at the Worker URL (only if UI is not same-origin):

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

Zone resources: **only the zones you need** — not Account Administrator.

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

- [ ] Set `PUBLIC_INTERNET=true`, `ALLOWED_ORIGINS`, `IP_ALLOWLIST` on production Worker  
- [ ] Strong `ADMIN_SECRET` (16+, not a placeholder) via `wrangler secret put`  
- [ ] Never commit `.dev.vars`, `.env`, or real tokens  
- [ ] Revoke any token/password that was pasted into chat  
- [ ] Cloudflare token only via `wrangler secret put` (least privilege)  
- [ ] Create users only from allowlisted IP / authenticated admin  
- [ ] Confirm 2FA enabled before sharing the live URL  
