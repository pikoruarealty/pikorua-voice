#!/usr/bin/env bash
# Pikorua Voice → VM, from your own machine (Git Bash on Windows works).
#
#   deploy/vm.sh setup        # once: Docker check, folder, DB + user, backups
#   deploy/vm.sh migrate-db   # once, before the first deploy: copy Neon → VM
#   deploy/vm.sh deploy       # every release: git pull on the VM, build, restart
#   deploy/vm.sh status
#   deploy/vm.sh logs [service]
# The VM defaults to root@187.126.115.164. Another login: VM=ubuntu@187.126.115.164 deploy/vm.sh …
#
# Reads the repo-root .env (app config) and .compose.env (BRANCH + tunnel token).
# The VM clones the repo into $REMOTE_DIR/repo and builds the images itself.
# Optional env: VM, SSH_OPTS="-p 2222 -i ~/.ssh/key", REMOTE_DIR (default /opt/pikorua-voice),
# GITHUB_TOKEN (read access to the repo) if the VM can't already git-pull it.
set -euo pipefail

CMD="${1:-}"
VM="${VM:-root@187.126.115.164}"
REMOTE_DIR="${REMOTE_DIR:-/opt/pikorua-voice}"
SSH_OPTS="${SSH_OPTS:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$REMOTE_DIR/repo"
# Run from $REPO_DIR (the checkout), where the compose file and build context live.
COMPOSE="docker compose --env-file ../.compose.env -f deploy/docker-compose.prod.yml"

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "==> $*"; }
usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

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
  [[ -f "$ROOT/.compose.env" ]] || die ".compose.env not found in $ROOT"
  grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=.+' "$ROOT/.compose.env" &&
    ! grep -q 'PASTE_TUNNEL_TOKEN_HERE' "$ROOT/.compose.env" ||
    die "paste your Cloudflare tunnel token into .compose.env (CLOUDFLARE_TUNNEL_TOKEN=)"
  [[ "$(env_value PUBLIC_BASE_URL)" == https://* ]] || die "PUBLIC_BASE_URL in .env must be https://…"
}

# Branch the VM deploys (BRANCH= in .compose.env, default v2).
deploy_branch() { grep -E '^BRANCH=' "$ROOT/.compose.env" | head -1 | cut -d= -f2- || true; }

# The VM pulls the branch from GitHub, so unpushed commits would silently not be deployed.
check_pushed() {
  local want branch
  want="$(deploy_branch)"; want="${want:-v2}"
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")"
  if [[ "$branch" == "$want" ]]; then
    git -C "$ROOT" fetch -q origin "$branch" 2>/dev/null || true
    if [[ -n "$(git -C "$ROOT" log "origin/$branch..HEAD" --oneline 2>/dev/null)" ]]; then
      die "branch $branch has commits not pushed to GitHub — git push first (the VM pulls from GitHub)"
    fi
  else
    echo "    note: the VM will deploy branch '$want' from GitHub (you are on '$branch')"
  fi
}

cmd_setup() {
  parse_db_url
  say "Checking Docker on $VM"
  remote 'docker info >/dev/null 2>&1' || die "Docker isn't usable by this SSH user.
  Install Docker Engine (https://docs.docker.com/engine/install/), then:
  sudo usermod -aG docker \$USER   (and log in again)"
  remote 'docker compose version >/dev/null' || die "install the docker compose plugin on the VM"
  remote 'command -v git >/dev/null' || die "install git on the VM (e.g. sudo apt install git)"

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

cmd_deploy() {
  check_local_files
  check_pushed
  local branch url
  branch="$(deploy_branch)"; branch="${branch:-v2}"
  url="$(git -C "$ROOT" remote get-url origin | sed -E 's#//[^@/]*@#//#')"

  say "Uploading .env and .compose.env to $VM:$REMOTE_DIR"
  upload "$ROOT/.env" "$VM:$REMOTE_DIR/.env"
  upload "$ROOT/.compose.env" "$VM:$REMOTE_DIR/.compose.env"
  remote "chmod 600 '$REMOTE_DIR/.env' '$REMOTE_DIR/.compose.env'"

  say "Pulling $branch from GitHub on the VM"
  local sync
  sync="$(mktemp)"
  # The token (if any) arrives on stdin, never on a command line.
  cat >"$sync" <<SYNC
set -euo pipefail
read -r T || true
if [ -n "\${T:-}" ]; then
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
  export GIT_CONFIG_VALUE_0="Authorization: Basic \$(printf 'x-access-token:%s' "\$T" | base64 -w0)"
fi
if [ -d '$REPO_DIR/.git' ]; then
  git -C '$REPO_DIR' fetch --prune origin '+refs/heads/$branch:refs/remotes/origin/$branch'
else
  git clone --single-branch --branch '$branch' '$url' '$REPO_DIR'
fi
git -C '$REPO_DIR' checkout -q -B '$branch' 'origin/$branch'
git -C '$REPO_DIR' reset -q --hard 'origin/$branch'
echo "    VM is on: \$(git -C '$REPO_DIR' log --oneline -1)"
SYNC
  upload "$sync" "$VM:$REMOTE_DIR/.sync.sh"
  rm -f "$sync"
  printf '%s\n' "${GITHUB_TOKEN:-}" |
    remote "bash '$REMOTE_DIR/.sync.sh'; rc=\$?; rm -f '$REMOTE_DIR/.sync.sh'; exit \$rc" ||
    die "git pull failed on the VM — a private repo needs read access: export GITHUB_TOKEN=<token> and re-run"

  say "Building images on the VM (uses both CPU cores for a few minutes)"
  remote "cd '$REPO_DIR' && $COMPOSE build" || die "image build failed (output above)"

  say "Restarting (live calls drain first — up to 4 min)"
  remote "cd '$REPO_DIR' && $COMPOSE up -d --remove-orphans" || die "docker compose up failed"

  say "Waiting for the API health check"
  local i
  for i in $(seq 1 40); do
    if remote "curl -fsS -m 5 http://127.0.0.1:4100/api/health >/dev/null 2>&1 || wget -qO- -T 5 http://127.0.0.1:4100/api/health >/dev/null 2>&1"; then
      say "API healthy on the VM"
      break
    fi
    [[ "$i" == 40 ]] && {
      remote "cd '$REPO_DIR' && $COMPOSE ps && $COMPOSE logs --tail 60 voice-api" || true
      die "API not healthy after 2 min (logs above). Database unreachable? See the setup notes."
    }
    sleep 3
  done

  local public
  public="$(env_value PUBLIC_BASE_URL)"
  if curl -fsS -m 10 "$public/api/health" >/dev/null 2>&1; then
    say "Public URL OK: $public"
  else
    echo "WARN: $public/api/health not reachable yet — check the tunnel: deploy/vm.sh logs voice-tunnel"
  fi
  remote "docker image prune -f >/dev/null 2>&1" || true
  say "Deployed."
}

cmd_status() {
  remote "cd '$REPO_DIR' && $COMPOSE ps && echo && curl -fsS -m 5 http://127.0.0.1:4100/api/health; echo"
}

cmd_logs() {
  remote "cd '$REPO_DIR' && $COMPOSE logs --tail 200 ${2:-}"
}

case "$CMD" in
  setup) cmd_setup ;;
  migrate-db) cmd_migrate_db ;;
  deploy) cmd_deploy ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  *) usage ;;
esac
