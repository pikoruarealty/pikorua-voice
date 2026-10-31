# Deploying Pikorua Voice on the VM

The API, worker, Redis and a Cloudflare Tunnel run as one Docker Compose stack on
the shared 2 vCPU / 8 GB VM. The database is the VM's own Postgres, in a
dedicated database and user. Each service has a CPU and
RAM cap so voice can never starve the VM's other projects, and those projects
can't make calls stutter. At most 2 calls run at once (Redis call-slot gate).

Public URL: **https://voice.pikoruarealty.com**. Traffic reaches the API through
the tunnel, which connects *out* to Cloudflare. The VM opens no inbound port for
voice, and there is no nginx.

| Container | CPU cap | RAM cap | Reachable from |
|---|---|---|---|
| voice-api | 1.0 | 512 MB | the tunnel; `127.0.0.1:4100` on the VM |
| voice-worker | 0.5 | 384 MB | compose network only |
| voice-tunnel (cloudflared) | 0.25 | 128 MB | outbound to Cloudflare only |
| voice-redis | 0.25 | 128 MB | compose network only |
| Postgres (VM host, not in compose) | — | — | containers via `host.docker.internal` |

**Redis is the stack's own `voice-redis` container. Don't point voice at another
project's Redis, or at Upstash.**

- **Eviction:** BullMQ (dial, post-call and CRM-retry jobs) needs
  `maxmemory-policy noeviction`. A shared Redis tuned for caching evicts keys
  under memory pressure, and that silently deletes queued dials and CRM syncs.
- **Collisions:** another project's `FLUSHALL`/`FLUSHDB`, or a clash on db 0,
  would wipe call state and the call-slot gate.
- **Isolation:** it has no host port (no clash on 6379), append-only persistence
  (survives restarts), and a 128 MB cap.
- **Upstash:** BullMQ's constant polling burns its command quota, and every
  command pays a network round trip.

The compose file sets `REDIS_URL=redis://voice-redis:6379` itself, so any old
Upstash `REDIS_URL` left in `.env` is ignored.

## Quick path: `deploy/vm.sh`

Everything below is scripted. Run it from your machine (Git Bash on Windows works),
from the repo root, with the repo-root `.env` filled in (including `CLOUDFLARE_TUNNEL_TOKEN`):

```bash
deploy/vm.sh setup       # once: Docker check, folder, DB + user, daily backups
deploy/vm.sh migrate-db  # once, BEFORE the first deploy: copy Neon data
deploy/vm.sh deploy      # every release: send the code + .env to the VM, build, restart, health check
deploy/vm.sh status
deploy/vm.sh logs voice-api
```

The VM is `root@187.126.115.164` by default; for another login run
`VM=ubuntu@187.126.115.164 deploy/vm.sh deploy`.

Images are **built by GitHub Actions** (`.github/workflows/images.yml`, on every push to
`main`/`v2`) and stored in GHCR. The VM never builds. `deploy` sends only the compose file
and `.env` (chmod 600), pulls the images for a commit, restarts, and waits for `/api/health`.

- Order: `git push` → wait for the green **Build images** run → `deploy/vm.sh deploy`
  (deploys your `HEAD`; `deploy/vm.sh deploy <full-sha>` deploys/rolls back to any built commit).
- One time: `deploy/vm.sh registry-login` — gives the VM a read-only GitHub token
  (`read:packages`) so it can pull the private images.
- The VM keeps a note of what it runs in `/opt/pikorua-voice/repo/.deployed-from`.
- Use `SSH_OPTS="-p 2222 -i key"` for a non-default SSH port or key.

**A build uses both of the VM's CPU cores for a few minutes.** Deploy when no
campaign is running, or live calls will stutter.

What's still manual: the Cloudflare tunnel (§2), and, if the health check says
the DB is unreachable, the two Postgres config lines `setup` prints.

## What you see at https://voice.pikoruarealty.com

Both pages ask for a login: **any username, password = `DASHBOARD_PASSWORD`** from `.env`.

- **`/status`: service dashboard.** One row per dependency with the vendor's own
  message: Database, Redis, OpenRouter (credit left), Sarvam (key + credits),
  ElevenLabs (characters left), Deepgram, Exotel (account active). Green = OK,
  amber = running low, red = down. Also shows calls in progress (of 2) and
  whether the AI fallback switch is open. Refreshes every minute; "Check now" forces it.
- **`/costs`: spend.** Total spend, average cost per answered call, and a
  per-service table (AI replies, voice, speech-to-text, phone lines) with a
  recent-calls list, for 24 h / 7 / 30 / 90 days. AI cost is exactly what
  OpenRouter billed; the rest is estimated from call time and characters at the
  rates in `.env` (`USD_INR`, `SARVAM_TTS_INR_PER_10K_CHARS`, `STT_INR_PER_HOUR`,
  `EXOTEL_INR_PER_MIN`). Set `EXOTEL_INR_PER_MIN` to your real rate, or phone cost
  shows as ₹0 and the page says so. Only calls made after this version was
  deployed have AI cost recorded.
- **`/`: browser test call.** Talk to Maya from your browser, no phone needed.
- Exotel's call stream, webhooks, the CRM and `/api/health` are not behind the
  password.

Sarvam has no balance API, so its row works by making a 2-character test
synthesis (about ₹0.0006): "No credits available" shows up in red.
Exotel's wallet balance isn't exposed either; check it in Exotel's dashboard.

## 1. Preflight (once, before installing anything)

Run during a normal busy hour for the other projects:

```bash
nproc; free -h; df -h /
vmstat 1 30                                  # 'id' = idle %, 'st' = CPU steal %
curl -s ipinfo.io | grep -E 'city|country'
for h in api.exotel.com api.sarvam.ai openrouter.ai; do
  curl -so /dev/null -w "$h connect=%{time_connect}s\n" https://$h; done
```

| Check | Needed | If not |
|---|---|---|
| VM location | India (or Singapore) | Every audio round trip pays the distance; latency targets are unreachable |
| Idle CPU with other projects running | ≥ 60% | Upgrade to 4 vCPU |
| Free RAM | ≥ 1.5 GB | Upgrade |
| CPU steal `st` | < 5% sustained | Noisy host: audio will jitter. Change instance |
| Instance type | **Not burstable** (AWS t2/t3/t4g, Azure B-series, GCP shared-core) | Burst credits run out mid-campaign and calls fail |
| Connect time to Exotel / Sarvam | < 50 ms | Wrong region |
| Free disk | ≥ 5 GB | Clean up first (plus room for DB backups) |

## 2. One-time setup

### Postgres on the VM

Give voice its **own database and user**. Never reuse another project's database.

```bash
sudo -u postgres psql <<'SQL'
CREATE USER pikorua_voice WITH PASSWORD '<strong password>';
CREATE DATABASE pikorua_voice OWNER pikorua_voice;
SQL
```

The containers reach the host's Postgres over Docker's bridge network, not
localhost, so Postgres must accept that network:

- `postgresql.conf`: `listen_addresses = 'localhost,172.17.0.1'`, or `'*'` if
  the firewall blocks 5432 from outside. Compose networks can use other
  172.x addresses, so `'*'` plus the firewall is simplest.
- `pg_hba.conf`: add
  `host  pikorua_voice  pikorua_voice  172.16.0.0/12  scram-sha-256`
- Then run `sudo systemctl restart postgresql`.
- **Never expose 5432 publicly:** `sudo ufw deny 5432` (or don't allow it). The
  tunnel doesn't need it.

In `/opt/pikorua-voice/.env`:

```
DATABASE_URL=postgresql://pikorua_voice:<password>@host.docker.internal:5432/pikorua_voice
```

Use no `sslmode`; it's local traffic. Tables are created automatically by the
migrations when the API first starts.

**Move the existing data from Neon** (calls, leads, appointments), once, before
the first start on the VM. Pause campaigns first so nothing writes to Neon
during the copy:

```bash
pg_dump "<NEON_DATABASE_URL>" --no-owner --no-privileges -Fc -f neon.dump
pg_restore --no-owner --role=pikorua_voice -d "postgresql://pikorua_voice:<password>@localhost:5432/pikorua_voice" neon.dump
```

The VM's `pg_dump` must be the same major version as Neon's Postgres or newer.

**Backups.** Neon did these for you; now nothing does unless you set it up. Make
a daily dump, keep 14 days, and copy them off the VM (a dump on the same disk
doesn't survive losing the VM):

```bash
sudo mkdir -p /var/backups/pikorua-voice && sudo chown postgres: /var/backups/pikorua-voice
# /etc/cron.d/pikorua-voice-backup
15 3 * * * postgres pg_dump -Fc pikorua_voice -f /var/backups/pikorua-voice/$(date +\%F).dump && find /var/backups/pikorua-voice -name '*.dump' -mtime +14 -delete
```

Test a restore once into a scratch database. A backup you've never restored
isn't a backup.

### Cloudflare Tunnel

1. Go to Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a
   tunnel** → **Cloudflared**, and name it `pikorua-voice`.
2. Copy the **tunnel token**, the long string after `--token`, into `.env` as
   `CLOUDFLARE_TUNNEL_TOKEN="..."`. You don't need to
   run the install command it shows; the compose stack runs cloudflared for you.
3. **Public hostname** → add:

   | Field | Value |
   |---|---|
   | Subdomain | `voice` |
   | Domain | `pikoruarealty.com` |
   | Type | `HTTP` |
   | URL | `voice-api:4100` |

   Use `voice-api:4100` because cloudflared runs in the same compose network as
   the API. If you ever run cloudflared on the host instead of in the container,
   use `localhost:4100`.
4. **Security → Bots:** make sure Bot Fight Mode / Super Bot Fight Mode doesn't
   challenge `voice.pikoruarealty.com`. Exotel's servers and the CRM can't solve a
   challenge, so their callbacks and WebSockets would silently fail. If it's on
   for the zone, add a WAF *Skip* rule for this hostname.

WebSockets work through the tunnel with no extra setting.

### VM

```bash
# Docker Engine + compose plugin: https://docs.docker.com/engine/install/
sudo useradd -m -s /bin/bash pikorua && sudo usermod -aG docker pikorua
sudo mkdir -p /opt/pikorua-voice && sudo chown pikorua: /opt/pikorua-voice

sudo -iu pikorua
cd /opt/pikorua-voice
# The code and both env files are sent by `deploy/vm.sh deploy` (nothing to
# download here). If you do it by hand, put them at:
#   /opt/pikorua-voice/.env           (app settings)
#   /opt/pikorua-voice/repo/          (the project's files)
chmod 600 .env
```

In `/opt/pikorua-voice/.env`, set:

- `NODE_ENV=production`
- `PUBLIC_BASE_URL=https://voice.pikoruarealty.com` (Exotel status callbacks)
- `DATABASE_URL` (the VM's Postgres, see above), plus the Exotel, Sarvam,
  OpenRouter, ElevenLabs, Deepgram and CRM keys you use today.

`REDIS_URL`, `PORT`, the call limits and `TRUST_PROXY` come from the compose
file; don't set them here.

In Exotel:

- **Voicebot applet stream URL:** `wss://voice.pikoruarealty.com/exotel-stream`
- **Status callback:** set automatically from `PUBLIC_BASE_URL`.

Host safety nets: 2 GB swap with `vm.swappiness=10` (OOM guard only), and NTP
on. The CRM webhook HMAC timestamp checks need a correct clock. The firewall
needs no new inbound port for voice.

## 3. Deploy

`deploy/vm.sh deploy` does all of this. By hand, in `/opt/pikorua-voice` on the VM:

```bash
export IMAGE_TAG=<full commit sha>
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
curl -fsS http://127.0.0.1:4100/api/health && curl -fsS https://voice.pikoruarealty.com/api/health
```

- **Live calls are safe.** On SIGTERM the old API stops taking new calls
  (inbound callers get the busy line) and waits up to 230 s for live calls to
  finish. Deploy outside the dial window anyway when you can.
- **Migrations run automatically** when the API starts, under a Postgres lock,
  so two instances can't race.

**Rollback:** `deploy/vm.sh deploy <previous-full-sha>` — the old images are still in GHCR.
Voice vendors roll back without a deploy: set `TTS_PROVIDER_HI=elevenlabs` or
`STT_PROVIDER=deepgram` in `.env` and run `up -d`.

## 4. Watch

| Signal | Where | Alert when |
|---|---|---|
| API up | external pinger (UptimeRobot / BetterStack free) on `https://voice.pikoruarealty.com/api/health` | down > 1 min |
| Tunnel connected | Cloudflare dashboard → Tunnels → status; `docker compose logs voice-tunnel` | not "Healthy" |
| Event-loop lag | `/api/metrics` → `pikorua_event_loop_lag_ms{quantile="p99"}` | > 30 ms: API starved of CPU, audio will stutter |
| Restarts / OOM kills | `docker compose ps`, `docker events` | any |
| CPU steal | `vmstat 1` → `st` | > 5% |
| Disk | `df -h` | < 15% free (`docker image prune -f`) |
| DB backup | `ls -lt /var/backups/pikorua-voice \| head -2` | newest dump older than 1 day |
| Other projects' latency | their own monitoring | > +20% vs before voice moved in |

## 5. Scaling

Change one thing at a time, then re-check the table above.

1. **4 vCPU / 16 GB:** raise `MAX_CONCURRENT_CALLS` to 4 (API and worker both)
   and the API cap to 1.5 CPU. Check your Sarvam plan's rate limit first.
2. **Own VM:** once voice is a real revenue line, move it off the shared VM.
