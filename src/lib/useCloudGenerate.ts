/**
 * useCloudGenerate Hook
 *
 * 替代原来 App.tsx 中直连 AI provider 的逻辑。
 * 通过云端网关发起请求，前端只负责渲染 + 断线恢复。
 */

import type { SyncSettings, StoredMessage } from "./storage";
import type { ProviderConfig } from "../providers/types";
import {
  cloudGatewayAvailable,
  getCloudRun,
  loadActiveCloudRun,
  saveActiveCloudRun,
  clearActiveCloudRun,
  streamViaCloudGateway,
  type CloudGenerateRequest,
  type CloudRunRecord,
  type ActiveCloudRun,
} from "./cloudGateway";

export interface CloudGenerateParams {
  settings: SyncSettings;
  providerConfig: ProviderConfig;
  model: string;
  conversationId: string;
  assistantMessageId: string;
  messages: StoredMessage[];

  // Agent & style
  agent?: {
    profile: string;
    memory: string;
    instructions: string;
    worldBook: string;
  } | null;
  userStyle?: string;
  injectCurrentTime?: boolean;

  // Context control
  pinnedSummary?: { text: string; pinnedAtMessageId: string } | null;
  historyDepth: number | "all";

  // Model params
  temperature?: number;
  reasoning?: { enabled: boolean; effort?: string; budgetTokens?: number };
  maxTokens?: number;

  // Cache
  contextPromptCache?: string;
  agentPromptCache?: string;

  // Tools
  tools?: any[];
  toolChoice?: string;
  clientOnlyTools?: string[];

  // Signal
  signal?: AbortSignal;
}

export interface CloudGenerateCallbacks {
  onThinkingDelta: (delta: string) => void;
  onTextDelta: (delta: string) => void;
  onToolCalls: (toolCalls: any[]) => void;
  onUsage: (usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

/**
 * 通过云端网关发起 AI 生成请求
 * 前端只负责消费 SSE 流并渲染
 */
export async function cloudGenerate(
  params: CloudGenerateParams,
  callbacks: CloudGenerateCallbacks,
): Promise<{ runId: string }> {
  const request: CloudGenerateRequest = {
    upstream: {
      baseUrl: params.providerConfig.baseUrl,
      apiKey: params.providerConfig.apiKey,
    },
    model: params.model,
    agent: params.agent,
    userStyle: params.userStyle,
    injectCurrentTime: params.injectCurrentTime,
    messages: params.messages,
    pinnedSummary: params.pinnedSummary,
    historyDepth: params.historyDepth,
    temperature: params.temperature,
    reasoning: params.reasoning,
    maxTokens: params.maxTokens,
    contextPromptCache: params.contextPromptCache,
    agentPromptCache: params.agentPromptCache,
    tools: params.tools,
    toolChoice: params.toolChoice,
    clientOnlyTools: params.clientOnlyTools,
    conversationId: params.conversationId,
    assistantMessageId: params.assistantMessageId,
  };

  // Save active run for recovery
  const activeRun: ActiveCloudRun = {
    runId: "", // Will be filled from response header
    conversationId: params.conversationId,
    assistantMessageId: params.assistantMessageId,
    model: params.model,
    providerId: params.providerConfig.id,
    createdAt: Date.now(),
  };

  try {
    let runId = "";

    const stream = streamViaCloudGateway({
      settings: params.settings,
      request,
      signal: params.signal,
      onRunId: (id) => {
        runId = id;
        activeRun.runId = id;
        saveActiveCloudRun(activeRun);
      },
    });

    for await (const chunk of stream) {
      if (chunk.usage) {
        callbacks.onUsage(chunk.usage as any);
      }

      if (chunk.kind === "thinking") {
        callbacks.onThinkingDelta(chunk.delta);
      } else if (chunk.kind === "text") {
        callbacks.onTextDelta(chunk.delta);
      } else if (chunk.kind === "tool_calls") {
        callbacks.onToolCalls(chunk.toolCalls ?? []);
      }

      if (chunk.done) break;
    }

    callbacks.onDone();
    clearActiveCloudRun();
    return { runId };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.name !== "AbortError") {
      callbacks.onError(err);
    }
    throw err;
  }
}

/**
 * 页面加载时检查并恢复未完成的生成
 */
export async function recoverPendingGeneration(
  settings: SyncSettings,
): Promise<CloudRunRecord | null> {
  const active = loadActiveCloudRun();
  if (!active) return null;

  try {
    const record = await getCloudRun(settings, active.runId);
    if (!record) {
      clearActiveCloudRun();
      return null;
    }

    if (record.status === "done" || record.status === "error") {
      clearActiveCloudRun();
    }

    return record;
  } catch {
    // Network error — don't clear, might recover later
    return null;
  }
}

/**
 * 检查云端网关是否可用
 */
export async function isCloudGatewayReady(settings: SyncSettings): Promise<boolean> {
  return cloudGatewayAvailable(settings);
}
