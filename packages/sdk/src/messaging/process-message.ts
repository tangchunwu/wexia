import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { Agent, ChatProgressUpdate, ChatRequest } from "../agent/interface.js";
import { sendTyping } from "../api/api.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { getExtensionFromMime } from "../media/mime.js";
import { logger } from "../util/logger.js";

import { setContextToken, bodyFromItemList, isMediaItem } from "./inbound.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { markdownToPlainText, sendMessageWeixin } from "./send.js";
import { handleSlashCommand } from "./slash-commands.js";

const MEDIA_TEMP_DIR = "/tmp/weixin-agent/media";
const PROGRESS_FIRST_DELAY_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 45_000;
const PROGRESS_TIMER_TICK_MS = 15_000;

function formatElapsedMs(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds} 秒`;
}

function buildProgressNotice(elapsedMs: number, detail?: string): string {
  const elapsed = formatElapsedMs(elapsedMs);
  if (detail) {
    return `⏳ 还在处理中，已运行 ${elapsed}\n当前进度：${detail}`;
  }
  return `⏳ 还在处理中，已运行 ${elapsed}`;
}

/** Save a buffer to a temporary file, returning the file path. */
async function saveMediaBuffer(
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  _maxBytes?: number,
  originalFilename?: string,
): Promise<{ path: string }> {
  const dir = path.join(MEDIA_TEMP_DIR, subdir ?? "");
  await fs.mkdir(dir, { recursive: true });
  let ext = ".bin";
  if (originalFilename) {
    ext = path.extname(originalFilename) || ".bin";
  } else if (contentType) {
    ext = getExtensionFromMime(contentType);
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);
  return { path: filePath };
}

/** Dependencies for processOneMessage. */
export type ProcessMessageDeps = {
  accountId: string;
  agent: Agent;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
};

/** Extract raw text from item_list (for slash command detection). */
function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Find the first downloadable media item from a message. */
function findMediaItem(itemList?: MessageItem[]): MessageItem | undefined {
  if (!itemList?.length) return undefined;

  // Direct media: IMAGE > VIDEO > FILE > VOICE (skip voice with transcription)
  const direct =
    itemList.find(
      (i) => i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param,
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.VIDEO && i.video_item?.media?.encrypt_query_param,
    ) ??
    itemList.find(
      (i) => i.type === MessageItemType.FILE && i.file_item?.media?.encrypt_query_param,
    ) ??
    itemList.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        i.voice_item?.media?.encrypt_query_param &&
        !i.voice_item.text,
    );
  if (direct) return direct;

  // Quoted media: check ref_msg
  const refItem = itemList.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  );
  return refItem?.ref_msg?.message_item ?? undefined;
}

/**
 * Process a single inbound message:
 *   slash command check → download media → call agent → send reply.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  const receivedAt = Date.now();
  const textBody = extractTextBody(full.item_list);
  let effectiveTextBody = textBody;

  // --- Slash commands ---
  if (textBody.startsWith("/")) {
    const conversationId = full.from_user_id ?? "";
    const slashResult = await handleSlashCommand(
      textBody,
      {
        to: conversationId,
        contextToken: full.context_token,
        baseUrl: deps.baseUrl,
        token: deps.token,
        accountId: deps.accountId,
        log: deps.log,
        errLog: deps.errLog,
        onClear: () => deps.agent.clearSession?.(conversationId),
        onSelectAgent: (agentKey) => deps.agent.selectAgent?.(conversationId, agentKey),
        getCurrentAgent: () => deps.agent.getCurrentAgent?.(conversationId),
        listAgents: () => deps.agent.listAgents?.(),
      },
      receivedAt,
      full.create_time_ms,
    );
    if (slashResult.handled) return;
    effectiveTextBody = slashResult.rewrittenText ?? textBody;
  }

  // --- Store context token ---
  const contextToken = full.context_token;
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }

  // --- Download media ---
  let media: ChatRequest["media"];
  const mediaItem = findMediaItem(full.item_list);
  if (mediaItem) {
    try {
      const downloaded = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl: deps.cdnBaseUrl,
        saveMedia: saveMediaBuffer,
        log: deps.log,
        errLog: deps.errLog,
        label: "inbound",
      });
      if (downloaded.decryptedPicPath) {
        media = { type: "image", filePath: downloaded.decryptedPicPath, mimeType: "image/*" };
      } else if (downloaded.decryptedVideoPath) {
        media = { type: "video", filePath: downloaded.decryptedVideoPath, mimeType: "video/mp4" };
      } else if (downloaded.decryptedFilePath) {
        media = {
          type: "file",
          filePath: downloaded.decryptedFilePath,
          mimeType: downloaded.fileMediaType ?? "application/octet-stream",
        };
      } else if (downloaded.decryptedVoicePath) {
        media = {
          type: "audio",
          filePath: downloaded.decryptedVoicePath,
          mimeType: downloaded.voiceMediaType ?? "audio/wav",
        };
      }
    } catch (err) {
      logger.error(`media download failed: ${String(err)}`);
    }
  }

  // --- Build ChatRequest ---
  const request: ChatRequest = {
    conversationId: full.from_user_id ?? "",
    text: effectiveTextBody || bodyFromItemList(full.item_list),
    media,
  };

  // --- Typing indicator (start + periodic refresh) ---
  const to = full.from_user_id ?? "";
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let progressChain = Promise.resolve();
  let lastProgressNoticeAt = 0;
  let latestProgressDetail = "";
  let latestProgressAt = receivedAt;
  let finished = false;

  const enqueueProgressNotice = (detail?: string) => {
    if (!contextToken || finished) return;
    const now = Date.now();
    if (now - receivedAt < PROGRESS_FIRST_DELAY_MS) return;
    if (lastProgressNoticeAt && now - lastProgressNoticeAt < PROGRESS_MIN_INTERVAL_MS) return;

    lastProgressNoticeAt = now;
    const text = buildProgressNotice(now - receivedAt, detail);
    progressChain = progressChain
      .then(() =>
        sendMessageWeixin({
          to,
          text,
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        }),
      )
      .catch((err) => {
        logger.error(`send progress notice failed: ${String(err)}`);
      });
  };

  request.onProgress = (update: ChatProgressUpdate) => {
    latestProgressAt = Date.now();
    latestProgressDetail = update.message;
    enqueueProgressNotice(update.message);
  };

  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTyping = () => {
    if (!deps.typingTicket) return;
    sendTyping({
      baseUrl: deps.baseUrl,
      token: deps.token,
      body: {
        ilink_user_id: to,
        typing_ticket: deps.typingTicket,
        status: TypingStatus.TYPING,
      },
    }).catch(() => {});
  };
  if (deps.typingTicket) {
    startTyping();
    typingTimer = setInterval(startTyping, 10_000);
  }
  progressTimer = setInterval(() => {
    if (finished) return;
    const detail = latestProgressDetail || "正在处理你的请求";
    if (Date.now() - latestProgressAt >= PROGRESS_TIMER_TICK_MS) {
      enqueueProgressNotice(detail);
    }
  }, PROGRESS_TIMER_TICK_MS);

  // --- Call agent & send reply ---
  try {
    const response = await deps.agent.chat(request);
    finished = true;

    if (response.media) {
      let filePath: string;
      const mediaUrl = response.media.url;
      if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
        filePath = await downloadRemoteImageToTemp(
          mediaUrl,
          path.join(MEDIA_TEMP_DIR, "outbound"),
        );
      } else {
        filePath = path.isAbsolute(mediaUrl) ? mediaUrl : path.resolve(mediaUrl);
      }
      await sendWeixinMediaFile({
        filePath,
        to,
        text: response.text ? markdownToPlainText(response.text) : "",
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
        cdnBaseUrl: deps.cdnBaseUrl,
      });
    } else if (response.text) {
      await sendMessageWeixin({
        to,
        text: markdownToPlainText(response.text),
        opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
      });
    }
  } catch (err) {
    finished = true;
    logger.error(`processOneMessage: agent or send failed: ${err instanceof Error ? err.stack ?? err.message : JSON.stringify(err)}`);
    void sendWeixinErrorNotice({
      to,
      contextToken,
      message: `⚠️ 处理消息失败：${err instanceof Error ? err.message : JSON.stringify(err)}`,
      baseUrl: deps.baseUrl,
      token: deps.token,
      errLog: deps.errLog,
    });
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    // --- Typing indicator (cancel) ---
    if (typingTimer) clearInterval(typingTimer);
    if (deps.typingTicket) {
      sendTyping({
        baseUrl: deps.baseUrl,
        token: deps.token,
        body: {
          ilink_user_id: to,
          typing_ticket: deps.typingTicket,
          status: TypingStatus.CANCEL,
        },
      }).catch(() => {});
    }
    await progressChain;
  }
}
