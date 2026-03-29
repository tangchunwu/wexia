import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpAgent } from "./acp-agent.js";

export type MultiAgentDefinition = {
  key: string;
  label: string;
  options: AcpAgentOptions;
};

function log(msg: string) {
  console.log(`[router] ${msg}`);
}

export class MultiAgentRouter implements Agent {
  private readonly definitions = new Map<string, MultiAgentDefinition>();
  private readonly instances = new Map<string, AcpAgent>();
  private readonly selectedAgents = new Map<string, string>();

  constructor(
    definitions: MultiAgentDefinition[],
    private readonly defaultAgentKey: string,
  ) {
    for (const definition of definitions) {
      this.definitions.set(definition.key, definition);
    }

    if (!this.definitions.has(defaultAgentKey)) {
      throw new Error(`default agent "${defaultAgentKey}" is not defined`);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const agentKey = this.getCurrentAgent(request.conversationId) ?? this.defaultAgentKey;
    const agent = this.getOrCreateAgent(agentKey);
    log(`dispatch conversation=${request.conversationId} agent=${agentKey}`);
    return agent.chat(request);
  }

  clearSession(conversationId: string): void {
    for (const agent of this.instances.values()) {
      agent.clearSession(conversationId);
    }
  }

  selectAgent(conversationId: string, agentKey: string): void {
    if (!this.definitions.has(agentKey)) {
      throw new Error(`unsupported agent: ${agentKey}`);
    }
    this.selectedAgents.set(conversationId, agentKey);
    log(`select conversation=${conversationId} agent=${agentKey}`);
  }

  getCurrentAgent(conversationId: string): string {
    return this.selectedAgents.get(conversationId) ?? this.defaultAgentKey;
  }

  listAgents(): string[] {
    return [...this.definitions.keys()];
  }

  dispose(): void {
    for (const agent of this.instances.values()) {
      agent.dispose();
    }
    this.instances.clear();
    this.selectedAgents.clear();
  }

  private getOrCreateAgent(agentKey: string): AcpAgent {
    const existing = this.instances.get(agentKey);
    if (existing) return existing;

    const definition = this.definitions.get(agentKey);
    if (!definition) {
      throw new Error(`unsupported agent: ${agentKey}`);
    }

    const agent = new AcpAgent(definition.options);
    this.instances.set(agentKey, agent);
    return agent;
  }
}
