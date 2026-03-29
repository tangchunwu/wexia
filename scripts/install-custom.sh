#!/bin/zsh
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ 目前只支持 macOS"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_BASE="${OPENCLAW_WECHAT_HOME:-$HOME/.openclaw/openclaw-weixin-custom}"
REPO_DIR="$INSTALL_BASE/weixin-agent-sdk"
LOG_DIR="$HOME/Library/Logs"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LAUNCH_LABEL="com.openclaw.weixin-acp"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$LAUNCH_LABEL.plist"
RUN_SCRIPT_PATH="$REPO_DIR/scripts/run-weixin-acp.sh"

mkdir -p "$INSTALL_BASE" "$LOG_DIR" "$LAUNCH_AGENTS_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未检测到 node，请先安装 Node.js 22+"
  exit 1
fi

NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(\".\")[0]')"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "❌ 当前 Node.js 版本过低：$("$NODE_BIN" -v)"
  echo "   请先升级到 Node.js 22+"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "ℹ️ 未检测到 pnpm，正在通过 corepack 启用"
    corepack enable
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ 未检测到 pnpm，请先安装 pnpm"
  exit 1
fi

echo "📦 同步定制版源码到: $REPO_DIR"
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
rsync -a \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude ".DS_Store" \
  "$SOURCE_REPO_ROOT/" "$REPO_DIR/"

chmod +x "$RUN_SCRIPT_PATH"

echo "📚 安装依赖"
cd "$REPO_DIR"
pnpm install

echo "🏗️ 构建 packages/sdk"
pnpm --filter weixin-agent-sdk run build

echo "🏗️ 构建 packages/weixin-acp"
pnpm --filter weixin-acp run build

echo "🧾 写入 LaunchAgent: $PLIST_PATH"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>-m</string>
    <string>$NODE_BIN</string>
    <string>dist/main.mjs</string>
    <string>codex</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO_DIR/packages/weixin-acp</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/weixin-acp.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/weixin-acp.stderr.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

echo "🚀 重载后台服务"
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"

echo
echo "✅ 安装完成"
echo "📁 安装目录: $REPO_DIR"
echo "🧩 LaunchAgent: $PLIST_PATH"
echo "📜 标准输出日志: $LOG_DIR/weixin-acp.stdout.log"
echo "📜 错误日志: $LOG_DIR/weixin-acp.stderr.log"
echo
echo "下一步："
echo "1. 首次登录微信："
echo "   cd \"$REPO_DIR\" && pnpm --filter weixin-acp exec node dist/main.mjs login"
echo "2. 查看后台状态："
echo "   launchctl print gui/\$(id -u)/$LAUNCH_LABEL | sed -n '1,80p'"
echo "3. 常用微信命令：/codex /gemini /claude /new /info /help"
