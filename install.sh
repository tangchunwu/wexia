#!/bin/zsh
set -euo pipefail

: "${WEIXIN_ACP_REPO_URL:=https://github.com/tangchunwu/wexia.git}"
: "${WEIXIN_ACP_REPO_REF:=main}"

RAW_BASE="https://raw.githubusercontent.com/tangchunwu/wexia/${WEIXIN_ACP_REPO_REF}"
TMP_SCRIPT="$(mktemp -t wexia-install.XXXXXX.sh)"
trap 'rm -f "$TMP_SCRIPT"' EXIT

curl -fsSL "$RAW_BASE/scripts/install-from-git.sh" -o "$TMP_SCRIPT"
chmod +x "$TMP_SCRIPT"

export WEIXIN_ACP_REPO_URL
export WEIXIN_ACP_REPO_REF

exec /bin/zsh "$TMP_SCRIPT"
