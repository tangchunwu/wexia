#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start with Codex
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 */

import path from "node:path";

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";
import { MultiAgentRouter, type MultiAgentDefinition } from "./src/multi-agent.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  gemini: { command: "gemini --acp" },
  codex: { command: "codex-acp" },
};

const localBin = (name: string) => path.resolve(process.cwd(), "node_modules", ".bin", name);

const ROUTED_AGENT_DEFINITIONS: MultiAgentDefinition[] = [
  {
    key: "codex",
    label: "Codex",
    options: {
      command: localBin("codex-acp"),
      cwd: process.cwd(),
    },
  },
  {
    key: "gemini",
    label: "Gemini",
    options: { command: "gemini", args: ["--acp", "--model", "gemini-2.5-pro"], cwd: process.cwd() },
  },
  {
    key: "claude",
    label: "Claude",
    options: {
      command: localBin("claude-agent-acp"),
      cwd: process.cwd(),
    },
  },
];

const command = process.argv[2];

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = []) {
  await ensureLoggedIn();

  const agent = new AcpAgent({ command: acpCommand, args: acpArgs });

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    agent.dispose();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    agent.dispose();
    ac.abort();
  });

  return start(agent, { abortSignal: ac.signal });
}

async function startRoutedAgents(defaultAgentKey: string) {
  await ensureLoggedIn();

  const agent = new MultiAgentRouter(ROUTED_AGENT_DEFINITIONS, defaultAgentKey);
  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    agent.dispose();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    agent.dispose();
    ac.abort();
  });

  console.log(
    `已启用多 Agent 模式，默认=${defaultAgentKey}，可在微信中使用 /codex /gemini /claude 切换`,
  );
  return start(agent, { abortSignal: ac.signal });
}

async function main() {
  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    logout();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    await startAgent(acpCommand, acpArgs);
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const routedDefault =
      command === "claude-code" ? "claude" : command === "gemini" ? "gemini" : "codex";
    await startRoutedAgents(routedDefault);
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                     启动多 Agent 模式，默认使用 Claude
  npx weixin-acp codex                           启动多 Agent 模式，默认使用 Codex
  npx weixin-acp gemini                          启动多 Agent 模式，默认使用 Gemini
  npx weixin-acp start -- <command> [args...]    使用自定义 agent

示例:
  npx weixin-acp start -- node ./my-agent.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
