/**
 * Cloud Gateway Clien  t
 *
 * 前端调用云端网关的所有 API 封装。
 * 取代原来前端直连 AI provider 的方式。
 */
import type { ChatContentPart } from "./attachments";
import type { SyncSettings, StoredMessage, Conversation } from "./storage";
import type { ProviderConfig, ChatStreamChunk } from "../providers/types";
import { OpenAICompatibleProvider } from "../providers/OpenAICompatibleProvider";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CloudGenerateRequest {
  // AI Provider
  upstream: { baseUrl: string; apiKey: string };
  model: string;

  // Agent context (Worker assembles system prompt)
  agent?: {
    profile: string;
    memory: string;
    instructions: string;
    worldBook: string;
  } | null;
  userStyle?: string;
  injectCurrentTime?: boolean;

  // Messages & history control
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string | ChatContentPart[];
  }>;
  pinnedSummary?: { text: string; pinnedAtMessageId: string } | null;
  historyDepth: number | "all";

  // Tool-loop continuation: 当本字段存在时，Worker 会跳过 system/pin/style/depth
  // 这些"首轮组装"，直接把数组原样作为 upstream 的 messages 发出去。
  // 用于多轮 MCP tool 调用：第 2 轮起，前端已经在本地把
  // [assistant tool_calls] 和 [role:"tool"] 追加到了消息序列里，
  // 必须原样透传，否则模型看不到工具结果会反复调用。
  overrideMessages?: any[];

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

  // Client-only tools that need callback
  clientOnlyTools?: string[];

  // Metadata
  conversationId: string;
  assistantMessageId: string;
}

export interface CloudRunRecord {
  app: "cedar-cloud-gateway-run";
  version: 2;
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  status: "streaming" | "done" | "error";
  createdAt: string;
  updatedAt: string;
  chunks: string[];
  thinkingText: string;
  contentText: string;
  toolCalls: any[];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | null;
  error: string | null;
  round: number;
  pendingToolRequest: any | null;
}

export interface ConversationMeta {
  id: string;
  title: string;
  model: string | null;
  providerId: string | null;
  agentId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ─── Gateway URL helpers ─────────────────────────────────────────────────────

function gatewayBaseUrl(settings: SyncSettings): string {
  const url = new URL(settings.endpoint.trim());
  // Strip /sync/... paths to get base
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/sync(\/.*)?$/, "");
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function gatewayUrl(settings: SyncSettings, path: string): string {
  return `${gatewayBaseUrl(settings)}${path}`;
}

function authHeaders(settings: SyncSettings): Record<string, string> {
  return { Authorization: `Bearer ${settings.syncCode.trim()}` };
}

// ─── Health Check ────────────────────────────────────────────────────────────

export async function cloudGatewayAvailable(settings: SyncSettings): Promise<boolean> {
  if (!settings.endpoint.trim() || settings.syncCode.trim().length < 8) return false;
  try {
    const response = await fetch(gatewayUrl(settings, "/health"), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const data = await response.json() as any;
    return data?.ok === true && data?.version >= 2;
  } catch {
    return false;
  }
}

// ─── Generate (发起云端 AI 生成) ──────────────────────────────────────────────

export async function* streamViaCloudGateway(params: {
  settings: SyncSettings;
  request: CloudGenerateRequest;
  signal?: AbortSignal;
  onRunId?: (runId: string) => void;
}): AsyncGenerator<ChatStreamChunk> {
  const { settings, request, signal, onRunId } = params;

  const response = await fetch(gatewayUrl(settings, "/ai/generate"), {
    method: "POST",
    headers: {
      ...authHeaders(settings),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Cloud gateway error ${response.status}: ${text.slice(0, 500)}`);
  }

  // Extract runId from response header
  const runId = response.headers.get("X-Cedar-AI-Run-Id");
  if (runId && onRunId) onRunId(runId);

  // Parse SSE stream using OpenAICompatibleProvider's stream parser
  const parser = new OpenAICompatibleProvider("gateway", request.upstream.baseUrl, "");
  yield* parser.streamResponse(response);
}

// ─── Get Run (恢复未完成的生成) ───────────────────────────────────────────────

export async function getCloudRun(
  settings: SyncSettings,
  runId: string,
): Promise<CloudRunRecord | null> {
  const response = await fetch(gatewayUrl(settings, `/ai/runs/${runId}`), {
    method: "GET",
    headers: { ...authHeaders(settings), Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Get run failed: ${response.status}`);
  return response.json() as Promise<CloudRunRecord>;
}

// ─── Subscribe (断线续接，从上次中断处恢复) ────────────────────────────────────

export async function* subscribeCloudRun(params: {
  settings: SyncSettings;
  runId: string;
  lastEventId?: number;
  providerConfig: ProviderConfig;
  signal?: AbortSignal;
}): AsyncGenerator<ChatStreamChunk> {
  const { settings, runId, lastEventId, providerConfig, signal } = params;

  const headers: Record<string, string> = {
    ...authHeaders(settings),
    Accept: "text/event-stream",
  };
  if (lastEventId !== undefined) {
    headers["Last-Event-ID"] = String(lastEventId);
  }

  const response = await fetch(gatewayUrl(settings, `/ai/runs/${runId}/subscribe`), {
    method: "GET",
    headers,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Subscribe failed: ${response.status}`);
  }

  // Parse the replayed chunks
  const parser = new OpenAICompatibleProvider(providerConfig.name, providerConfig.baseUrl, "");
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("event: done")) {
        // Stream completed
        return;
      }
      if (line.startsWith("event: error")) {
        // Error occurred
        return;
      }
      if (line.startsWith("data: ")) {
        const dataStr = line.slice(6);
        try {
          const data = JSON.parse(dataStr);
          if (data.raw) {
            // Replay raw chunk through the parser
            const fakeResponse = new Response(data.raw);
            for await (const chunk of parser.streamResponse(fakeResponse)) {
              yield chunk;
            }
          }
        } catch { /* skip invalid JSON */ }
      }
    }
  }
}

// ─── Delete Run ──────────────────────────────────────────────────────────────

export async function deleteCloudRun(settings: SyncSettings, runId: string): Promise<void> {
  await fetch(gatewayUrl(settings, `/ai/runs/${runId}`), {
    method: "DELETE",
    headers: authHeaders(settings),
  });
}

// ─── Tool Result (前端执行的 tool 结果回传) ───────────────────────────────────

export async function submitToolResult(
  settings: SyncSettings,
  runId: string,
  toolCallId: string,
  result: string,
): Promise<void> {
  const response = await fetch(gatewayUrl(settings, `/ai/runs/${runId}/tool-result`), {
    method: "POST",
    headers: { ...authHeaders(settings), "Content-Type": "application/json" },
    body: JSON.stringify({ toolCallId, result }),
  });
  if (!response.ok) {
    throw new Error(`Submit tool result failed: ${response.status}`);
  }
}

// ─── Conversations CRUD ──────────────────────────────────────────────────────

export async function listCloudConversations(
  settings: SyncSettings,
): Promise<ConversationMeta[]> {
  const response = await fetch(gatewayUrl(settings, "/conversations"), {
    method: "GET",
    headers: { ...authHeaders(settings), Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`List conversations failed: ${response.status}`);
  const data = await response.json() as any;
  return data.conversations ?? [];
}

export async function getCloudConversation(
  settings: SyncSettings,
  conversationId: string,
): Promise<{ conversation: Conversation } | null> {
  const response = await fetch(gatewayUrl(settings, `/conversations/${conversationId}`), {
    method: "GET",
    headers: { ...authHeaders(settings), Accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Get conversation failed: ${response.status}`);
  return response.json() as any;
}

export async function createCloudConversation(
  settings: SyncSettings,
  conversation: Partial<Conversation>,
): Promise<ConversationMeta> {
  const response = await fetch(gatewayUrl(settings, "/conversations"), {
    method: "POST",
    headers: { ...authHeaders(settings), "Content-Type": "application/json" },
    body: JSON.stringify(conversation),
  });
  if (!response.ok) throw new Error(`Create conversation failed: ${response.status}`);
  const data = await response.json() as any;
  return data.conversation;
}

export async function updateCloudConversation(
  settings: SyncSettings,
  conversationId: string,
  updates: Partial<Conversation>,
): Promise<ConversationMeta> {
  const response = await fetch(gatewayUrl(settings, `/conversations/${conversationId}`), {
    method: "PUT",
    headers: { ...authHeaders(settings), "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!response.ok) throw new Error(`Update conversation failed: ${response.status}`);
  const data = await response.json() as any;
  return data.conversation;
}

export async function deleteCloudConversation(
  settings: SyncSettings,
  conversationId: string,
): Promise<void> {
  const response = await fetch(gatewayUrl(settings, `/conversations/${conversationId}`), {
    method: "DELETE",
    headers: authHeaders(settings),
  });
  if (!response.ok) throw new Error(`Delete conversation failed: ${response.status}`);
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function getCloudMessages(
  settings: SyncSettings,
  conversationId: string,
): Promise<StoredMessage[]> {
  const response = await fetch(gatewayUrl(settings, `/conversations/${conversationId}/messages`), {
    method: "GET",
    headers: { ...authHeaders(settings), Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Get messages failed: ${response.status}`);
  const data = await response.json() as any;
  return data.messages ?? [];
}

export async function deleteCloudMessage(
  settings: SyncSettings,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const response = await fetch(
    gatewayUrl(settings, `/conversations/${conversationId}/messages/${messageId}`),
    { method: "DELETE", headers: authHeaders(settings) },
  );
  if (!response.ok) throw new Error(`Delete message failed: ${response.status}`);
}

// ─── Recover pending generation on page load ─────────────────────────────────

const ACTIVE_CLOUD_RUN_KEY = "cedar-chat.activeCloudRun";
const ACTIVE_CLOUD_RUN_TTL_MS = 12 * 60 * 60 * 1000;

export interface ActiveCloudRun {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  providerId: string;
  createdAt: number;
}

export function saveActiveCloudRun(run: ActiveCloudRun): void {
  try {
    localStorage.setItem(ACTIVE_CLOUD_RUN_KEY, JSON.stringify(run));
  } catch { /* best effort */ }
}

export function loadActiveCloudRun(): ActiveCloudRun | null {
  try {
    const raw = localStorage.getItem(ACTIVE_CLOUD_RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.createdAt < Date.now() - ACTIVE_CLOUD_RUN_TTL_MS) {
      clearActiveCloudRun();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearActiveCloudRun(): void {
  try {
    localStorage.removeItem(ACTIVE_CLOUD_RUN_KEY);
  } catch { /* best effort */ }
}
