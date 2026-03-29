/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void;
  /** Switch the default agent for a conversation. */
  selectAgent?(conversationId: string, agentKey: string): void;
  /** Get the current default agent for a conversation. */
  getCurrentAgent?(conversationId: string): string | undefined;
  /** List supported agent keys. */
  listAgents?(): string[];
}

export interface ChatProgressUpdate {
  /** Progress category. */
  kind: "heartbeat" | "thinking" | "tool";
  /** Human-readable progress message. */
  message: string;
}

export interface ChatRequest {
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /** Optional callback for intermediate progress signals while the agent is still working. */
  onProgress?: (update: ChatProgressUpdate) => void | Promise<void>;
  /** Attached media file (image, audio, video, or generic file). */
  media?: {
    type: "image" | "audio" | "video" | "file";
    /** Local file path (already downloaded and decrypted). */
    filePath: string;
    /** MIME type, e.g. "image/jpeg", "audio/wav". */
    mimeType: string;
    /** Original filename (available for file attachments). */
    fileName?: string;
  };
}

export interface ChatResponse {
  /** Reply text (may contain markdown — will be converted to plain text before sending). */
  text?: string;
  /** Reply media file. */
  media?: {
    type: "image" | "video" | "file";
    /** Local file path or HTTPS URL. */
    url: string;
    /** Filename hint (for file attachments). */
    fileName?: string;
  };
}
