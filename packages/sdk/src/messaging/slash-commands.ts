/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /clear                  清除当前会话，重新开始对话
 */
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";

import { toggleDebugMode, isDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
  /** 如果指令需要继续走 AI，这里返回改写后的文本。 */
  rewrittenText?: string;
}

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Called when /clear is invoked to reset the agent session. */
  onClear?: () => void;
  /** 切换当前会话默认 Agent。 */
  onSelectAgent?: (agentKey: string) => void;
  /** 获取当前会话默认 Agent。 */
  getCurrentAgent?: () => string | undefined;
  /** 获取当前可用 Agent 列表。 */
  listAgents?: () => string[];
}

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

const AGENT_COMMANDS: Record<string, { key: string; label: string }> = {
  "/codex": { key: "codex", label: "Codex" },
  "/gemini": { key: "gemini", label: "Gemini" },
  "/claude": { key: "claude", label: "Claude" },
};

function buildHelpText(ctx: SlashCommandContext): string {
  const current = ctx.getCurrentAgent?.() ?? "unknown";
  const available = ctx.listAgents?.() ?? [];
  const availableText = available.length > 0 ? available.join(" / ") : "codex / gemini / claude";

  return [
    "可用命令：",
    "/codex [问题]  切到 Codex；带内容时直接发送给 Codex",
    "/gemini [问题] 切到 Gemini；带内容时直接发送给 Gemini",
    "/claude [问题] 切到 Claude；带内容时直接发送给 Claude",
    "/clear 或 /new 清空当前 Agent 会话",
    "/info 查看当前 Agent",
    "/toggle-debug 开关调试模式",
    "/echo <内容> 直接回显",
    "",
    `当前 Agent: ${current}`,
    `可用 Agent: ${availableText}`,
  ].join("\n");
}

async function handleAgentSwitchCommand(
  command: string,
  args: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  const spec = AGENT_COMMANDS[command];
  if (!spec) return { handled: false };

  const supported = ctx.listAgents?.() ?? [];
  if (supported.length > 0 && !supported.includes(spec.key)) {
    await sendReply(ctx, `❌ 当前服务未启用 ${spec.label}`);
    return { handled: true };
  }

  ctx.onSelectAgent?.(spec.key);
  const prompt = args.trim();
  if (!prompt) {
    await sendReply(ctx, `✅ 当前会话已切换到 ${spec.label}`);
    return { handled: true };
  }

  return {
    handled: false,
    rewrittenText: prompt,
  };
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true };
      }
      case "/new":
      case "/clear": {
        ctx.onClear?.();
        await sendReply(ctx, "✅ 会话已清除，重新开始对话");
        return { handled: true };
      }
      case "/info": {
        const current = ctx.getCurrentAgent?.() ?? "unknown";
        const available = ctx.listAgents?.() ?? [];
        await sendReply(
          ctx,
          [
            `当前 Agent: ${current}`,
            `可用 Agent: ${available.length > 0 ? available.join(" / ") : "unknown"}`,
            `Debug 模式: ${isDebugMode(ctx.accountId) ? "开启" : "关闭"}`,
          ].join("\n"),
        );
        return { handled: true };
      }
      case "/help": {
        await sendReply(ctx, buildHelpText(ctx));
        return { handled: true };
      }
      case "/codex":
      case "/gemini":
      case "/claude":
        return await handleAgentSwitchCommand(command, args, ctx);
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true };
  }
}
