# Deploying Pikorua Voice on the VM

The API, worker, Redis and a Cloudflare Tunnel run as one Docker Compose stack on
the shared 2 vCPU / 8 GB VM. Postgres stays on Neon. Each service has a CPU and
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
| Free disk | ≥ 5 GB | Clean up first |

## 2. One-time setup

### Cloudflare Tunnel

1. Go to Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a
   tunnel** → **Cloudflared**, and name it `pikorua-voice`.
2. Copy the **tunnel token**, the long string after `--token`. You don't need to
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
curl -fsSLO https://raw.githubusercontent.com/pikoruarealty/pikorua-voice/v2/deploy/docker-compose.prod.yml
cp /path/to/your/.env .env && chmod 600 .env

# Images are private: log in with a GitHub token that has read:packages.
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# Compose settings + the tunnel token (kept out of the app's .env).
cat > .compose.env <<'EOF'
IMAGE_PREFIX=ghcr.io/pikoruarealty
TAG=v2
CLOUDFLARE_TUNNEL_TOKEN=<paste the tunnel token>
EOF
chmod 600 .compose.env
```

In `/opt/pikorua-voice/.env`, set:

- `NODE_ENV=production`
- `PUBLIC_BASE_URL=https://voice.pikoruarealty.com` (Exotel status callbacks)
- `DATABASE_URL` (Neon), plus the Exotel, Sarvam, OpenRouter, ElevenLabs,
  Deepgram and CRM keys you use today.

`REDIS_URL`, `PORT`, the call limits and `TRUST_PROXY` come from the compose
file; don't set them here.

In Exotel:

- **Voicebot applet stream URL:** `wss://voice.pikoruarealty.com/exotel-stream`
- **Status callback:** set automatically from `PUBLIC_BASE_URL`.

Host safety nets: 2 GB swap with `vm.swappiness=10` (OOM guard only), and NTP
on. The CRM webhook HMAC timestamp checks need a correct clock. The firewall
needs no new inbound port for voice.

## 3. Deploy

CI builds both images on every push to `v2` (and `main`) in
`.github/workflows/images.yml`. They're tagged with the branch name and the
commit SHA. On the VM:

```bash
cd /opt/pikorua-voice
docker compose --env-file .compose.env -f docker-compose.prod.yml pull
docker compose --env-file .compose.env -f docker-compose.prod.yml up -d
curl -fsS http://127.0.0.1:4100/api/health && curl -fsS https://voice.pikoruarealty.com/api/health
```

- **Live calls are safe.** On SIGTERM the old API stops taking new calls
  (inbound callers get the busy line) and waits up to 230 s for live calls to
  finish. Deploy outside the dial window anyway when you can.
- **Migrations run automatically** when the API starts, under a Postgres lock,
  so two instances can't race.
- **Pin a version** with `TAG=<commit-sha>` in `.compose.env` instead of `v2`.

**Rollback:** set `TAG=<previous-sha>` in `.compose.env` and run `up -d` again.
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
| Other projects' latency | their own monitoring | > +20% vs before voice moved in |

## 5. Scaling

Change one thing at a time, then re-check the table above.

1. **4 vCPU / 16 GB:** raise `MAX_CONCURRENT_CALLS` to 4 (API and worker both)
   and the API cap to 1.5 CPU. Check your Sarvam plan's rate limit first.
2. **Own VM:** once voice is a real revenue line, move it off the shared VM.
