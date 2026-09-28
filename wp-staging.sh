#!/usr/bin/env bash
#
# Single gateway for every WP-CLI read/write against the deploy target.
# Connection comes from config.json (same `ssh` block deploy.sh uses); WP-CLI
# runs in `remote_wp_root`, or — when that key is absent — in the path above
# /wp-content/ in `remote_theme_path`.
#
# Usage:
#   bash .deployment/wp-staging.sh <wp-cli args...>
#   bash .deployment/wp-staging.sh eval-file - < local-file.php
#
# Key auth only (BatchMode) — a password prompt would hang an agent.
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$DIR/config.json"
[ -f "$CONFIG" ] || { echo "config.json not found in $DIR" >&2; exit 1; }

read_cfg() { python3 -c "import json;c=json.load(open('$CONFIG'));print($1)"; }

HOST=$(read_cfg "c['ssh']['host']")
PORT=$(read_cfg "c['ssh'].get('port',22)")
USER=$(read_cfg "c['ssh']['username']")
KEY=$(read_cfg "c['ssh'].get('privateKey','')")
WP_ROOT=$(read_cfg "c.get('remote_wp_root') or c['remote_theme_path'].split('/wp-content/')[0]")

SSH_ARGS=(-p "$PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20)
[ -n "$KEY" ] && SSH_ARGS+=(-i "$KEY")

exec ssh "${SSH_ARGS[@]}" "${USER}@${HOST}" "cd $(printf '%q' "$WP_ROOT") && wp $(printf '%q ' "$@")"
