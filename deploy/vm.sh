#!/usr/bin/env bash
# Pikorua Voice → VM, from your own machine (Git Bash on Windows works).
#
#   deploy/vm.sh setup        # once: Docker check, folder, DB + user, backups
#   deploy/vm.sh migrate-db   # once, before the first deploy: copy Neon → VM
#   deploy/vm.sh deploy [sha] # every release: VM pulls the GitHub-built images, restarts
#   deploy/vm.sh registry-login   # once: let the VM pull from GHCR (GitHub token, read:packages)
#   deploy/vm.sh status
#   deploy/vm.sh logs [service]
# The VM defaults to root@187.126.115.164. Another login: VM=ubuntu@187.126.115.164 deploy/vm.sh …
#
# Reads the repo-root .env (app config + CLOUDFLARE_TUNNEL_TOKEN).
# Images are built by GitHub Actions (.github/workflows/images.yml) on every push to
# main/v2 and stored in GHCR. The VM never builds: deploy sends only the compose file
# and .env, then pulls the images for commit [sha] (default: your HEAD — push it first
# and wait for the green "Build images" run).
# Optional env: VM, SSH_OPTS="-p 2222 -i ~/.ssh/key", REMOTE_DIR (default /opt/pikorua-voice).
set -euo pipefail

CMD="${1:-}"
VM="${VM:-root@187.126.115.164}"
REMOTE_DIR="${REMOTE_DIR:-/opt/pikorua-voice}"
SSH_OPTS="${SSH_OPTS:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Run from $REMOTE_DIR, where .env and the compose file live. IMAGE_TAG is set by deploy.
COMPOSE="docker compose --env-file .env -f docker-compose.prod.yml"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }
usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

[[ -n "$CMD" ]] || usage

# shellcheck disable=SC2086
remote() { ssh $SSH_OPTS "$VM" "$@"; }
# -t: a terminal, so sudo can ask for a password.
# shellcheck disable=SC2086
remote_tty() { ssh -t $SSH_OPTS "$VM" "$@"; }
# shellcheck disable=SC2086
upload() { scp -q $SSH_OPTS "$@"; }

env_value() { # value of KEY= in .env, quotes stripped
  grep -E "^$1=" "$ROOT/.env" | head -1 | cut -d= -f2- | sed -E 's/^["'\'']//; s/["'\'']$//'
}

# DATABASE_URL → DB_USER DB_PASS DB_NAME (postgresql://user:pass@host:port/db)
parse_db_url() {
  local url
  url="$(env_value DATABASE_URL)"
  [[ "$url" =~ ^postgres(ql)?://([^:]+):([^@]+)@([^:/]+)(:[0-9]+)?/([^?]+) ]] ||
    die "DATABASE_URL in .env is not postgresql://user:password@host:port/db"
  DB_USER="${BASH_REMATCH[2]}"
  DB_PASS="${BASH_REMATCH[3]}"
  DB_NAME="${BASH_REMATCH[6]}"
  [[ "$DB_PASS" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die "use only letters, digits, - and _ in the DB password (it goes into SQL and a URL)"
}

check_local_files() {
  [[ -f "$ROOT/.env" ]] || die ".env not found in $ROOT"
  local token
  token="$(env_value CLOUDFLARE_TUNNEL_TOKEN)"
  [[ -n "$token" && "$token" != *PASTE_TUNNEL_TOKEN_HERE* ]] ||
    die "add your Cloudflare tunnel token to .env:  CLOUDFLARE_TUNNEL_TOKEN=\"...\""
  [[ "$(env_value PUBLIC_BASE_URL)" == https://* ]] || die "PUBLIC_BASE_URL in .env must be https://…"
}

cmd_setup() {
  parse_db_url
  say "Checking Docker on $VM"
  remote 'docker info >/dev/null 2>&1' || die "Docker isn't usable by this SSH user.
  Install Docker Engine (https://docs.docker.com/engine/install/), then:
  sudo usermod -aG docker \$USER   (and log in again)"
  remote 'docker compose version >/dev/null' || die "install the docker compose plugin on the VM"
  remote 'command -v tar >/dev/null' || die "tar is missing on the VM"

  say "Creating $REMOTE_DIR"
  remote_tty "sudo mkdir -p '$REMOTE_DIR' && sudo chown \"\$(id -un)\": '$REMOTE_DIR' && chmod 750 '$REMOTE_DIR'"

  say "Creating Postgres role '$DB_USER' and database '$DB_NAME' (idempotent)"
  local sql
  sql="$(mktemp)"
  cat >"$sql" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASS';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec
SQL
  upload "$sql" "$VM:$REMOTE_DIR/.setup.sql"
  rm -f "$sql"
  remote_tty "chmod 600 '$REMOTE_DIR/.setup.sql' && sudo -u postgres psql -v ON_ERROR_STOP=1 -q < '$REMOTE_DIR/.setup.sql'; rc=\$?; rm -f '$REMOTE_DIR/.setup.sql'; exit \$rc"

  say "Daily DB backup at 03:15, 14 days kept (/var/backups/pikorua-voice)"
  remote_tty "sudo mkdir -p /var/backups/pikorua-voice && sudo chown postgres: /var/backups/pikorua-voice && sudo chmod 700 /var/backups/pikorua-voice &&
    echo '15 3 * * * postgres pg_dump -Fc $DB_NAME -f /var/backups/pikorua-voice/\$(date +\%F).dump && find /var/backups/pikorua-voice -name \"*.dump\" -mtime +14 -delete' |
    sudo tee /etc/cron.d/pikorua-voice-backup >/dev/null && sudo chmod 644 /etc/cron.d/pikorua-voice-backup"

  say "Checking Postgres accepts the Docker network (needed by the containers)"
  remote_tty "echo -n '    listen_addresses = '; sudo -u postgres psql -tAc 'SHOW listen_addresses'" || true
  cat <<EOF

Setup done. One manual step if the deploy health check later fails on the DB:
  postgresql.conf : listen_addresses = '*'   (5432 stays closed in the firewall)
  pg_hba.conf     : host  $DB_NAME  $DB_USER  172.16.0.0/12  scram-sha-256
  then            : sudo systemctl restart postgresql
Next: deploy/vm.sh migrate-db   (copies Neon data — before the first deploy)
EOF
}

cmd_migrate_db() {
  parse_db_url
  local neon
  neon="$(grep -E '^# NEON_DATABASE_URL=' "$ROOT/.env" | head -1 | sed -E 's/^# NEON_DATABASE_URL=//; s/^["'\'']//; s/["'\'']$//')"
  [[ -n "$neon" ]] || die "no '# NEON_DATABASE_URL=' line in .env — nothing to copy from"
  echo "Copying Neon → $DB_NAME on the VM. Pause campaigns first: writes to Neon after"
  echo "this point are not copied."
  read -r -p "Continue? [y/N] " ok
  [[ "$ok" == [yY] ]] || exit 1

  local job
  job="$(mktemp)"
  cat >"$job" <<JOB
set -euo pipefail
command -v pg_dump >/dev/null || { echo "pg_dump not installed on the VM"; exit 1; }
TARGET="postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME"
if [ "\$(psql "\$TARGET" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" = "t" ]; then
  echo "The VM database already has tables — refusing to overwrite. To redo the copy,"
  echo "drop and re-run setup:  sudo -u postgres dropdb $DB_NAME"
  exit 1
fi
echo "pg_dump: \$(pg_dump --version)"
pg_dump '$neon' --no-owner --no-privileges -Fc -f '$REMOTE_DIR/.neon.dump'
pg_restore --no-owner --role=$DB_USER -d "\$TARGET" '$REMOTE_DIR/.neon.dump'
rm -f '$REMOTE_DIR/.neon.dump'
psql "\$TARGET" -tAc "SELECT 'calls copied: ' || count(*) FROM calls"
JOB
  upload "$job" "$VM:$REMOTE_DIR/.migrate.sh"
  rm -f "$job"
  remote "chmod 600 '$REMOTE_DIR/.migrate.sh' && bash '$REMOTE_DIR/.migrate.sh'; rc=\$?; rm -f '$REMOTE_DIR/.migrate.sh' '$REMOTE_DIR/.neon.dump'; exit \$rc"
  say "Data copied. Once the VM is live and checked, delete the NEON_DATABASE_URL line from .env."
}

cmd_registry_login() {
  echo "Create a GitHub token (classic) with ONLY the read:packages scope:"
  echo "  https://github.com/settings/tokens/new?scopes=read:packages"
  read -r -p "GitHub username: " gh_user
  read -r -s -p "Token: " gh_token
  echo
  # Token goes over stdin, never into the command line or shell history on the VM.
  printf '%s' "$gh_token" | remote "docker login ghcr.io -u '$gh_user' --password-stdin"
}

cmd_deploy() {
  check_local_files
  local tag="${1:-}"
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "run this from the project's git checkout"
  [[ -n "$tag" ]] || tag="$(git -C "$ROOT" rev-parse HEAD)"
  [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || die "give the full 40-character commit sha (or nothing for HEAD)"
  if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]]; then
    echo "    note: uncommitted edits are not part of the images (they are built from the pushed commit)"
  fi

  # ONE tar stream over ONE ssh connection (one password prompt): the compose file,
  # .env, and the script that pulls the images and restarts.
  local stage
  stage="$(mktemp -d)"
  trap 'rm -rf "$stage"' RETURN
  cp "$ROOT/.env" "$stage/env"
  cp "$ROOT/deploy/docker-compose.prod.yml" "$stage/docker-compose.prod.yml"
  cat >"$stage/run.sh" <<RUN
set -euo pipefail
D='$REMOTE_DIR'
I="\$D/.incoming"
install -m 600 "\$I/env" "\$D/.env"
install -m 644 "\$I/docker-compose.prod.yml" "\$D/docker-compose.prod.yml"
rm -rf "\$I" "\$D/repo"
cd "\$D"
export IMAGE_TAG='$tag'
echo "==> Pulling images for $tag"
$COMPOSE pull voice-api voice-worker || { echo "ERROR: pull failed. Is the 'Build images' run for this commit green, and did you run 'deploy/vm.sh registry-login' once?" >&2; exit 1; }
echo "==> Restarting (live calls drain first — up to 4 min)"
$COMPOSE up -d --remove-orphans
echo '$tag' > "\$D/.image-tag"
echo "==> Waiting for the API health check"
for i in \$(seq 1 40); do
  if curl -fsS -m 5 http://127.0.0.1:4100/api/health >/dev/null 2>&1 || wget -qO- -T 5 http://127.0.0.1:4100/api/health >/dev/null 2>&1; then
    echo "==> API healthy on the VM"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 3
done
$COMPOSE ps
$COMPOSE logs --tail 60 voice-api || true
echo "ERROR: API not healthy after 2 min (logs above). Database unreachable? See the setup notes." >&2
exit 1
RUN

  say "Deploying commit ${tag:0:7} to $VM — compose file + .env only, images come from GHCR"
  tar -cf - -C "$stage" . |
    remote "rm -rf '$REMOTE_DIR/.incoming' && mkdir -p '$REMOTE_DIR/.incoming' && tar -xf - -C '$REMOTE_DIR/.incoming' && bash '$REMOTE_DIR/.incoming/run.sh'" ||
    die "deploy failed on the VM (output above)"

  local public
  public="$(env_value PUBLIC_BASE_URL)"
  if curl -fsS -m 10 "$public/api/health" >/dev/null 2>&1; then
    say "Public URL OK: $public"
  else
    echo "WARN: $public/api/health not reachable yet — check the tunnel: deploy/vm.sh logs voice-tunnel"
  fi
  say "Deployed."
}

cmd_status() {
  remote "cd '$REMOTE_DIR' && export IMAGE_TAG=\$(cat .image-tag) && $COMPOSE ps && echo && curl -fsS -m 5 http://127.0.0.1:4100/api/health; echo"
}

cmd_logs() {
  remote "cd '$REMOTE_DIR' && export IMAGE_TAG=\$(cat .image-tag) && $COMPOSE logs --tail 200 ${2:-}"
}

case "$CMD" in
  setup) cmd_setup ;;
  migrate-db) cmd_migrate_db ;;
  registry-login) cmd_registry_login ;;
  deploy) shift; cmd_deploy "$@" ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  *) usage ;;
esac
