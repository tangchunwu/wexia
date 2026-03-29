import type { Agent, ChatProgressUpdate, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId, SessionNotification } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

const ACP_TURN_TIMEOUT_MS = 600_000;

function describeToolUpdate(update: {
  title?: string | null;
  kind?: string | null;
  toolCallId?: string;
}): string {
  return update.title ?? update.kind ?? update.toolCallId ?? "工具调用";
}

function toProgressUpdate(notification: SessionNotification): ChatProgressUpdate | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "tool_call":
      return {
        kind: "tool",
        message: `正在执行：${describeToolUpdate(update)}`,
      };
    case "tool_call_update":
      if (update.status === "in_progress") {
        return {
          kind: "tool",
          message: `继续执行：${describeToolUpdate(update)}`,
        };
      }
      return null;
    case "agent_thought_chunk":
      return {
        kind: "thinking",
        message: "正在分析并处理你的请求",
      };
    case "agent_message_chunk":
      return {
        kind: "heartbeat",
        message: "正在整理回复内容",
      };
    default:
      return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.connection = new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conn = await this.connection.ensureReady();

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(request.conversationId, conn);

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    if (request.onProgress) {
      this.connection.registerProgressListener(sessionId, (notification) => {
        const progress = toProgressUpdate(notification);
        if (progress) {
          void request.onProgress?.(progress);
        }
      });
    }
    try {
      await withTimeout(
        conn.prompt({ sessionId, prompt: blocks }),
        ACP_TURN_TIMEOUT_MS,
        `Agent 请求超时（>${Math.floor(ACP_TURN_TIMEOUT_MS / 1000)} 秒）`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("请求超时")) {
        log(`timeout: resetting agent process for session=${sessionId}`);
        this.connection.dispose();
        this.sessions.clear();
      }
      throw error;
    } finally {
      this.connection.unregisterCollector(sessionId);
      this.connection.unregisterProgressListener(sessionId);
    }

    const response = await collector.toResponse();
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    log(`session created: ${res.sessionId}`);
    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.connection.dispose();
  }
}
