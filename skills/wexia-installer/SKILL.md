---
name: wexia-installer
description: Install, upgrade, or repair the Wexia WeChat bridge from the tangchunwu/wexia GitHub repository on macOS, including launchd auto-start, logs, login, and quick health checks.
---

# Wexia Installer

Use this skill when the user wants to install, upgrade, reinstall, or troubleshoot the Wexia WeChat bridge.

## What this installs

- Repo: `https://github.com/tangchunwu/wexia.git`
- Default branch: `main`
- Install root: `~/.openclaw/openclaw-weixin-custom/weixin-agent-sdk`
- LaunchAgent: `com.openclaw.weixin-acp`
- Logs:
  - `~/Library/Logs/weixin-acp.stdout.log`
  - `~/Library/Logs/weixin-acp.stderr.log`

## Default install command

```bash
curl -fsSL https://raw.githubusercontent.com/tangchunwu/wexia/main/install.sh | zsh
```

## Alternate install command

Use this when the user wants a specific branch:

```bash
WEIXIN_ACP_REPO_URL=https://github.com/tangchunwu/wexia.git \
WEIXIN_ACP_REPO_REF=<branch> \
zsh <(curl -fsSL https://raw.githubusercontent.com/tangchunwu/wexia/<branch>/scripts/install-from-git.sh)
```

## Common follow-up commands

### Login WeChat

```bash
cd ~/.openclaw/openclaw-weixin-custom/weixin-agent-sdk
pnpm --filter weixin-acp exec node dist/main.mjs login
```

### Check service status

```bash
launchctl print gui/$(id -u)/com.openclaw.weixin-acp | sed -n '1,80p'
```

### Tail logs

```bash
tail -f ~/Library/Logs/weixin-acp.stdout.log
tail -f ~/Library/Logs/weixin-acp.stderr.log
```

## What to verify after install

1. `launchctl` shows `state = running`
2. stdout log shows:
   - `已启用多 Agent 模式`
   - `[weixin] 启动 bot`
3. user can send `/codex` `/gemini` `/claude` in WeChat

## Notes

- macOS only
- Requires Node.js 22+, `git`, and `pnpm` or `corepack`
- Default model routing:
  - `codex`
  - `gemini-2.5-pro`
  - `claude`
- Long tasks can run up to 10 minutes and send periodic progress notices
