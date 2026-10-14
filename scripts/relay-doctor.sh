#!/usr/bin/env bash
#
# relay-doctor — one command that says whether the Tabsend relay is healthy.
#
#   ./scripts/relay-doctor.sh
#
# Takes no arguments and changes nothing. Read-only by construction: it inspects,
# reads logs, and asks the relay about itself. It never restarts, rebuilds, prunes
# or deletes. Repairs are a separate, deliberate step (docs/RUNBOOK.md).
#
# WHY THIS EXISTS. The relay runs unattended on a machine nobody logs into, and the
# person who owns it is usually asking an agent rather than typing. Before this, the
# answer to "is it working?" required knowing to run docker inspect, then knowing which
# pino level number means error, then knowing what a healthy queue depth looks like.
# This is that knowledge, written down once and executable.
#
# It reports what it COULD NOT check, and why, as loudly as what it did check. A
# diagnosis assembled from three of five checks is worth less than one that says which
# two are missing: an agent that cannot reach the Docker daemon must report a
# permission problem, not a healthy relay.
#
# Exit codes:  0 everything checked and healthy
#              1 problems found
#              2 the essentials could not be checked at all
#
# Env overrides: TABSEND_CONTAINER (default: tabsend-relay)
#                TABSEND_LOG_WINDOW (default: 24h)

set -uo pipefail

CONTAINER="${TABSEND_CONTAINER:-tabsend-relay}"
LOG_WINDOW="${TABSEND_LOG_WINDOW:-24h}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"

# Findings, printed together at the end. NOTE for future edits: under `set -u`, bash 3.2
# (what macOS still ships) treats iterating an EMPTY array as an unbound variable and
# aborts. Every `for … in "${PROBLEMS[@]}"` below is therefore guarded by a length check.
# Keep it that way, or the healthy path dies on a Mac.
PROBLEMS=()
SKIPPED=()

problem() { PROBLEMS+=("$1"); }
skipped() { SKIPPED+=("$1"); }
heading() { printf '\n%s\n%s\n' "$1" "$(printf '%*s' "${#1}" '' | tr ' ' '-')"; }

printf 'Tabsend relay doctor\n'
printf 'Run at    %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
printf 'On host   %s, as user %s\n' "$(hostname 2>/dev/null || echo unknown)" "$(id -un 2>/dev/null || echo unknown)"
printf 'Container %s\n' "$CONTAINER"

# --- 1. can we talk to Docker at all -----------------------------------------
# Everything else depends on this, so its failure modes get named precisely: an agent
# that just prints "docker: command not found" leaves the owner guessing whether the
# relay is down or the check is.

heading 'Docker access'
DOCKER_OK=0
if ! command -v docker >/dev/null 2>&1; then
  printf 'docker is not installed, or not on PATH for this user.\n'
  skipped 'Everything: docker is not available to this user.'
elif ! docker info >/dev/null 2>&1; then
  printf 'docker is installed but this user cannot talk to the Docker daemon.\n'
  printf 'Usually the user is missing from the docker group. To fix, as an admin:\n'
  printf '  sudo usermod -aG docker %s\n' "$(id -un 2>/dev/null || echo '<user>')"
  printf 'The user must then log out and back in for it to take effect.\n'
  skipped 'Everything: no permission to talk to the Docker daemon.'
else
  DOCKER_OK=1
  printf 'ok (%s)\n' "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'version unknown')"
fi

if [ "$DOCKER_OK" -eq 0 ]; then
  heading 'Verdict'
  printf 'COULD NOT CHECK. The relay may be perfectly fine; this machine did not let us look.\n'
  for item in "${SKIPPED[@]}"; do printf '  not checked: %s\n' "$item"; done
  exit 2
fi

# --- 2. the container --------------------------------------------------------

heading 'Container'
RUNNING=0
EXISTS=0
if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  printf 'No container named "%s" exists on this machine.\n' "$CONTAINER"
  OTHERS="$(docker ps -a --filter 'ancestor=tabsend-relay' --format '{{.Names}} ({{.Status}})' 2>/dev/null)"
  if [ -n "$OTHERS" ]; then
    printf 'Other containers from the tabsend-relay image:\n%s\n' "$OTHERS"
    printf 'Re-run with TABSEND_CONTAINER=<name> if one of those is the relay.\n'
  fi
  problem 'The relay container does not exist. Nothing is serving.'
  skipped 'Relay status, storage and log checks: no container to ask.'
else
  EXISTS=1
  STATE="$(docker container inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)"
  RESTARTS="$(docker container inspect -f '{{.RestartCount}}' "$CONTAINER" 2>/dev/null)"
  STARTED="$(docker container inspect -f '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)"
  HEALTH="$(docker container inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' "$CONTAINER" 2>/dev/null)"
  IMAGE_BUILT="$(docker container inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null | xargs -I{} docker image inspect -f '{{.Created}}' {} 2>/dev/null)"

  printf 'State         %s\n' "$STATE"
  printf 'Health        %s\n' "$HEALTH"
  printf 'Started       %s\n' "$STARTED"
  printf 'Restarts      %s\n' "$RESTARTS"
  printf 'Image built   %s\n' "${IMAGE_BUILT:-unknown}"

  case "$STATE" in
    running) RUNNING=1 ;;
    restarting)
      problem 'The container is stuck restarting. It starts, fails, and starts again.'
      ;;
    *)
      problem "The container is not running (state: $STATE)."
      ;;
  esac

  if [ "$HEALTH" = 'unhealthy' ]; then
    problem 'Docker reports the container as unhealthy: it is up but not answering its own health check.'
  fi
  # A restart loop shows as a high count against a short uptime. Docker's own
  # `restart: unless-stopped` will happily hide a crash that recovers, so this is the
  # only place a repeated crash becomes visible after the fact.
  if [ "${RESTARTS:-0}" -gt 5 ]; then
    problem "The container has restarted $RESTARTS times. Something is crashing it."
  fi

  if [ "$RUNNING" -eq 0 ]; then
    printf '\nLast 30 log lines before it stopped:\n'
    docker logs --tail 30 "$CONTAINER" 2>&1 | sed 's/^/  /'
    skipped 'Relay status and storage: the container is not running.'
  fi
fi

# --- 3. ask the relay about itself -------------------------------------------
# From INSIDE the container: /admin/status answers loopback callers only, and under
# bridge networking a call from the host arrives from the docker gateway instead.

REPORT_FAILED=0
if [ "$RUNNING" -eq 1 ]; then
  heading 'Relay self-report'
  REPORT="$(docker exec "$CONTAINER" server/node_modules/.bin/tsx server/src/scripts/status-report.ts 2>&1)"
  REPORT_CODE=$?
  printf '%s\n' "$REPORT"
  case "$REPORT_CODE" in
    0) ;;
    3)
      # The report itself listed them, so record one entry rather than duplicating.
      problem 'The relay reported problems with itself (listed under "Problems found" above).'
      ;;
    *)
      REPORT_FAILED=1
      problem 'The relay is running but could not report on itself (see the message above).'
      ;;
  esac
fi

# --- 4. storage --------------------------------------------------------------
# Asked inside the container so it needs no root on the host, and so it measures the
# filesystem the relay actually writes to rather than whatever / happens to be.

if [ "$RUNNING" -eq 1 ]; then
  heading 'Storage'
  if DF="$(docker exec "$CONTAINER" df -h /data 2>/dev/null | tail -n +2)"; then
    printf 'Volume /data  %s\n' "$DF"
    USED_PCT="$(printf '%s' "$DF" | awk '{print $5}' | tr -d '%')"
    if [ -n "$USED_PCT" ] && [ "$USED_PCT" -ge 90 ] 2>/dev/null; then
      problem "The relay's disk is ${USED_PCT}% full. When it fills, pairing and sending stop."
    fi
  else
    skipped 'Disk space: could not read /data inside the container.'
  fi

  # The TLS keypair is the one file on this machine that cannot be regenerated without
  # breaking every paired phone (ADR-0019: phones pin the key from the pairing link).
  # Confirming it is present is cheap; discovering it is gone after a `down -v` is not.
  if docker exec "$CONTAINER" test -f /data/tls/key.pem 2>/dev/null; then
    printf 'TLS keypair   present (do not delete: every paired phone pins it)\n'
  elif docker exec "$CONTAINER" test -d /data 2>/dev/null; then
    printf 'TLS keypair   absent (expected when TLS_SELF_SIGNED is off)\n'
  fi
fi

# --- 5. recent failures in the log -------------------------------------------

# Gated on the container EXISTING, not on it running: a crash loop (state `restarting`)
# is the case where the log is the only evidence there is, and it is exactly the state a
# running-or-exited test would skip.
if [ "$EXISTS" -eq 1 ]; then
  heading "Errors logged in the last $LOG_WINDOW"
  LOGS="$(docker logs --since "$LOG_WINDOW" "$CONTAINER" 2>&1)"
  # pino levels: 50 error, 60 fatal. Matching the JSON field avoids counting every
  # line that merely contains the word "error" in a URL or a device label.
  ERROR_LINES="$(printf '%s' "$LOGS" | grep -c '"level":5[0-9]\|"level":60' 2>/dev/null || true)"
  ERROR_LINES="${ERROR_LINES:-0}"
  printf 'Error lines   %s\n' "$ERROR_LINES"
  if [ "$ERROR_LINES" -gt 0 ] 2>/dev/null; then
    printf 'Most recent:\n'
    printf '%s' "$LOGS" | grep '"level":5[0-9]\|"level":60' | tail -5 | cut -c1-400 | sed 's/^/  /'
    problem "$ERROR_LINES error line(s) in the relay log in the last $LOG_WINDOW."
  fi
else
  skipped "Log scan: no container to read logs from."
fi

# --- 6. is the running relay the build we think it is ------------------------
# The reason this check earns its place: updating means rebuilding an image and
# recreating the container, and a step skipped there leaves the OLD relay running
# while the repo says the update landed. Nothing else would notice.

heading 'Build in the repo'
if [ -f "$REPO_ROOT/package.json" ]; then
  REPO_VERSION="$(grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  printf 'Repo checkout %s\n' "$REPO_ROOT"
  printf 'Repo version  %s\n' "${REPO_VERSION:-unknown}"
  if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    printf 'Repo commit   %s on %s\n' \
      "$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null)" \
      "$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    DIRTY="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    [ "${DIRTY:-0}" -gt 0 ] && printf 'Uncommitted   %s file(s) changed\n' "$DIRTY"
  fi

  if [ "$RUNNING" -eq 1 ] && [ "$REPORT_FAILED" -eq 0 ] && [ -n "${REPORT:-}" ]; then
    RUNNING_VERSION="$(printf '%s' "$REPORT" | awk '/^  Version /{print $2; exit}')"
    printf 'Relay reports %s\n' "${RUNNING_VERSION:-unknown}"
    # Both sides must be real version strings. A relay that cannot read its own manifest
    # reports the literal "unknown" (server/src/version.ts), and comparing that as a
    # string would accuse the operator of skipping a rebuild they did not skip.
    if [ -n "${REPO_VERSION:-}" ] && [ -n "${RUNNING_VERSION:-}" ] &&
      [ "$REPO_VERSION" != 'unknown' ] && [ "$RUNNING_VERSION" != 'unknown' ] &&
      [ "$REPO_VERSION" != "$RUNNING_VERSION" ]; then
      problem "The running relay is version $RUNNING_VERSION but the repo here is $REPO_VERSION. An update was checked out but never rebuilt into the container."
    elif [ "${RUNNING_VERSION:-unknown}" = 'unknown' ]; then
      skipped 'Version comparison: the relay could not report its own build.'
    fi
  fi
else
  skipped 'Version comparison: this script is not inside a Tabsend checkout.'
fi

# --- verdict -----------------------------------------------------------------

heading 'Verdict'
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  printf 'HEALTHY. Nothing needs attention.\n'
else
  printf 'PROBLEMS FOUND (%s)\n' "${#PROBLEMS[@]}"
  for item in "${PROBLEMS[@]}"; do printf '  - %s\n' "$item"; done
fi

if [ ${#SKIPPED[@]} -gt 0 ]; then
  printf '\nNot checked:\n'
  for item in "${SKIPPED[@]}"; do printf '  - %s\n' "$item"; done
fi

printf '\nWhat to do about any of this: docs/RUNBOOK.md in the Tabsend repo.\n'

[ ${#PROBLEMS[@]} -eq 0 ] || exit 1
[ ${#SKIPPED[@]} -eq 0 ] || exit 2
exit 0
