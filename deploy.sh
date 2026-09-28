#!/usr/bin/env bash
#
# Deploy the theme over rsync+ssh — the alternative to the sftp tool
# (`bun run deploy`). Use it when the host disables the sftp subsystem
# (Flywheel's SSH gateway does), or simply for faster delta transfers.
# rsync speaks its own protocol over a plain ssh exec channel.
#
# Requires key auth (BatchMode): `ssh.password` is not supported here.
#
# Connection details and the exclude list are read from config.json, so the two
# deploy paths stay in sync.
#
# Usage:
#   ./deploy.sh              # dry run — prints what would change
#   ./deploy.sh --apply      # actually transfer
#   ./deploy.sh --apply --delete   # also remove remote files that no longer exist locally
#
set -euo pipefail

cd "$(dirname "$0")"

CONFIG="config.json"
[ -f "$CONFIG" ] || { echo "config.json not found"; exit 1; }

read_cfg() { python3 -c "import json,sys;print(json.load(open('$CONFIG'))$1)"; }

HOST=$(read_cfg "['ssh']['host']")
PORT=$(read_cfg "['ssh']['port']")
USER=$(read_cfg "['ssh']['username']")
KEY=$(read_cfg "['ssh'].get('privateKey','')")
REMOTE=$(read_cfg "['remote_theme_path']")
LOCAL=$(read_cfg "['local_theme_path']")

# rsync matches a slash-free pattern at any depth, so '**/' prefixes are noise.
# (macOS ships bash 3.2 — no mapfile, so read the list the portable way.)
RSYNC_ARGS=(-avz --human-readable)
while IFS= read -r e; do
  [ -n "$e" ] && RSYNC_ARGS+=(--exclude "$e")
done < <(python3 -c "
import json
for p in json.load(open('$CONFIG'))['exclude']:
    print(p[3:] if p.startswith('**/') else p)
")

APPLY=0
for a in "$@"; do
  case "$a" in
    --apply)  APPLY=1 ;;
    --delete) RSYNC_ARGS+=(--delete) ;;   # excluded files on the remote are kept
    *) echo "unknown flag: $a"; exit 1 ;;
  esac
done
[ "$APPLY" -eq 1 ] || RSYNC_ARGS+=(--dry-run)

SSH_CMD="ssh -p $PORT -o BatchMode=yes"
[ -n "$KEY" ] && SSH_CMD="$SSH_CMD -i '$KEY'"

echo "→ ${USER}@${HOST}:${REMOTE}"
[ "$APPLY" -eq 1 ] || echo "  (dry run — pass --apply to transfer)"

rsync "${RSYNC_ARGS[@]}" -e "$SSH_CMD" "$LOCAL" "${USER}@${HOST}:${REMOTE}/"

# Vite writes content-hashed filenames, and a plain rsync only ADDS — so every
# build ever deployed piles up in source/build/ on the server. That is not just
# clutter: the theme resolves its assets with the glob `source/build/asset.app-*.css`
# and takes the FIRST match, so an old build whose hash happens to sort earlier
# (a leading digit beats a leading letter) keeps being served forever while the
# real one sits beside it unused. It looks exactly like "the deploy didn't work".
# Locally there is only ever one file, so it only ever breaks on the server.
#
# Hence: the build directory is MIRRORED, not merged. Confined to that one
# directory, where every file is a regenerated artifact and nothing is authored.
if [ "$APPLY" -eq 1 ] && [ -d "${LOCAL}source/build" ]; then
  echo "→ mirroring source/build (removes superseded hashed assets)"
  rsync -az --delete -e "$SSH_CMD" "${LOCAL}source/build/" "${USER}@${HOST}:${REMOTE}/source/build/"
fi

if [ "$APPLY" -eq 1 ]; then
  # The path cache stores absolute paths; a copy carried over from another
  # machine hard-fatals the site. Drop it so the server regenerates its own.
  eval "$SSH_CMD ${USER}@${HOST} 'rm -f ${REMOTE}/theme-require-mapping.json'"
  echo "✓ deployed; build mirrored; stale theme-require-mapping.json cleared"

  # Post-deploy commands from config.json `deployment.steps` — same contract as
  # the sftp tool: {remote_theme_path} is substituted, each runs over ssh.
  while IFS=$'\t' read -r name cmd; do
    [ -n "$name" ] || continue
    echo "→ step: $name"
    eval "$SSH_CMD \"\${USER}@\${HOST}\" \"\$cmd\""   # cmd stays one arg; the remote shell parses it
  done < <(python3 -c "
import json
c = json.load(open('$CONFIG'))
for k, v in (c.get('deployment') or {}).get('steps', {}).items():
    print(k + '\t' + v.replace('{remote_theme_path}', c['remote_theme_path']))
")
fi
