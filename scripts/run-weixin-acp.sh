#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ACP_DIR="$REPO_ROOT/packages/weixin-acp"

cd "$ACP_DIR"
exec /opt/homebrew/bin/node dist/main.mjs codex
