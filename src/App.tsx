// 主界面：provider/model 选择 + 能力感知的控件 + 消息列表 + 输入框
//
// 设计要点：
// 1. "全自定义 provider"：所有 provider 来自 localStorage，没有硬编码
// 2. UI 查询 capability 表决定显示哪些控件（temperature 滑块 vs reasoning effort）
// 3. 流式消息：assistant 消息边收边渲染，thinking 和 text 分开显示

import { MarkdownText } from "./components/MarkdownText";

import {
  Component,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent,
  type DragEvent,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Settings, type SettingsTab } from "./components/Settings";
import {
  createProvider,
  getCapability,
  type ChatAttachment,
  type ChatContentPart,
  type ChatMessage,
  type ChatTextContentPart,
  type ChatTool,
  type ChatToolCall,
  type ContentBlock,
  type ModelCapability,
  type ProviderConfig,
  type ToolBlock,
  type VoiceBlock,
} from "./providers";
import {
  attachmentFromFile,
  contentBlocksToPlainText,
  contentBlocksToPromptParts,
  formatBytes,
  hasUserContent,
} from "./lib/attachments";
import { playTts, stopBrowserTts, synthesizeSpeech } from "./lib/tts";
import {
  loadProviders,
  saveProviders,
  loadCurrent,
  saveCurrent,
  loadPreferences,
  normalizeChatFontSize,
  savePreferences,
  loadTtsSettings,
  saveTtsSettings,
  loadSyncSettings,
  saveSyncSettings,
  getActiveTtsProfile,
  loadMcpServers,
  saveMcpServers,
  loadAgents,
  saveAgents,
  loadActiveAgentId,
  saveActiveAgentId,
  loadConversations,
  saveConversations,
  loadActiveConversationId,
  saveActiveConversationId,
  newAgentId,
  newConversationId,
  type Agent,
  type ClaudePromptCacheMode,
  type ClaudePromptCacheTTL,
  type Conversation,
  type CurrentSelection,
  type ThinkingEffort,
  type ThinkingMode,
  type McpServerConfig,
  type StoredMessage,
  type StoredMessageAlternative,
  type Preferences,
  type SyncSettings,
  type TtsSettings,
  loadUserStyleSettings,
  saveUserStyleSettings,
  getActiveUserStyle,
  type UserStyleSettings,
} from "./lib/storage";
import { summarizeThinking } from "./lib/thinkingSummary";
import {
  callMcpTool,
  listMcpServerTools,
  type McpToolSummary,
} from "./lib/mcp";
import {
  searchConversationTitles,
  searchConversations,
  type SearchResult,
} from "./lib/search";
import {
  loadLocalBackup,
  saveLocalBackup,
  saveLocalBackupSoon,
  type CedarLocalBackup,
} from "./lib/localBackup";
import {
  pullSyncBlob,
  pullSyncSnapshot,
  pushSyncBlob,
  pushSyncSnapshot,
  syncSnapshotDataSignature,
  type CedarSyncBlobRef,
  type CedarSyncSnapshot,
} from "./lib/sync";
import {
  aiGatewayAvailable,
  canUseAiGateway,
  clearActiveAiGatewayRun,
  loadActiveAiGatewayRun,
  newAiGatewayRunId,
  pullAiGatewayRun,
  saveActiveAiGatewayRun,
  streamChunksFromAiGatewayRun,
  streamOpenAICompatibleViaGateway,
} from "./lib/aiGateway";
import {
  cloudGatewayAvailable,
  streamViaCloudGateway,
  loadActiveCloudRun,
  saveActiveCloudRun,
  clearActiveCloudRun,
  getCloudRun,
  deleteCloudConversation,
  type CloudGenerateRequest,
} from "./lib/cloudGateway";

import { useAutoSync } from "./lib/useAutoSync";

// ------------------------- Message type (UI-level) -------------------------

interface UIMessage extends StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  streaming?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}

interface ChatExportPayload {
  app: "cedar-chat";
  version: 1;
  exportedAt: string;
  agents: Agent[];
  conversations: Conversation[];
}

interface ActiveMcpTool {
  functionName: string;
  server: McpServerConfig;
  sessionId?: string;
  toolName: string;
  displayName: string;
  chatTool: ChatTool;
}

type ChatHistorySearchScope = "current" | "all";
type SidebarSearchScope = "agent" | "all";

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_REASONING_ENABLED = true;
const DEFAULT_THINKING_MODE: ThinkingMode = "effort";
const DEFAULT_THINKING_EFFORT: ThinkingEffort = "medium";
const DEFAULT_THINKING_BUDGET_TOKENS = 8192;
const DEFAULT_LEGACY_CLAUDE_PROMPT_CACHE: ClaudePromptCacheMode = "off";
const DEFAULT_AGENT_PROMPT_CACHE: ClaudePromptCacheTTL = "1h";
const DEFAULT_CONTEXT_PROMPT_CACHE: ClaudePromptCacheTTL = "5m";
const DEFAULT_MULTI_MESSAGE_ENABLED = false;
const DEFAULT_VOICE_MESSAGES_ENABLED = false;
const DEFAULT_VOICE_MESSAGE_BUDGET_TOKENS = 160;
const MAX_MCP_TOOL_ROUNDS = 6;
const MAX_MCP_RESULT_CHARS = 120_000;
const MAX_TOOL_BLOCK_CHARS = 4_000;
const STREAM_COMMIT_INTERVAL_MS = 80;
const STREAM_LARGE_COMMIT_INTERVAL_MS = 160;
const STREAM_HUGE_COMMIT_INTERVAL_MS = 260;
const STREAM_LARGE_TEXT_CHARS = 30_000;
const STREAM_HUGE_TEXT_CHARS = 70_000;
const STREAM_DURABLE_SAVE_INTERVAL_MS = 700;
const STREAM_SYNC_COOLDOWN_MS = 10_000;
const CONVERSATION_SAVE_DELAY_MS = 350;
const STREAMING_PLAIN_TEXT_CHARS = 24_000;
function isMobileStreamDevice() {
  if (typeof window === "undefined") return false;
  if (typeof navigator === "undefined") return window.innerWidth <= 768;

  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || window.innerWidth <= 768;
}

function isDocumentHidden() {
  if (typeof document === "undefined") return false;
  return document.hidden;
}

function getMobileSafeCommitInterval(textLength: number) {
  if (textLength >= STREAM_HUGE_TEXT_CHARS) {
    return Math.max(STREAM_HUGE_COMMIT_INTERVAL_MS, 1200);
  }

  if (textLength >= STREAM_LARGE_TEXT_CHARS) {
    return Math.max(STREAM_LARGE_COMMIT_INTERVAL_MS, 1000);
  }

  return Math.max(STREAM_COMMIT_INTERVAL_MS, 500);
}
const PROTECTED_STREAM_MESSAGES_KEY = "cedar-chat.protectedStreamMessages";
const PROTECTED_STREAM_MESSAGES_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PROTECTED_STREAM_MESSAGES = 40;
const CHAT_HISTORY_SEARCH_TOOL_NAME = "search_chat_history";
const DEFAULT_CHAT_HISTORY_SEARCH_LIMIT = 10;
const MAX_CHAT_HISTORY_SEARCH_LIMIT = 30;
const WEATHER_LOCATION = "Beijing";
const WEATHER_FALLBACK_LABEL = "多云";
const TOKENS_PER_MILLION = 1_000_000;
const OPUS_46_47_PRICING_PER_MTOK = {
  input: 5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
  output: 25,
};

type WindowSettingsPatch = Partial<
  Pick<
    Conversation,
    | "providerId"
    | "model"
    | "temperature"
    | "reasoningEnabled"
    | "thinkingMode"
    | "thinkingEffort"
    | "thinkingBudgetTokens"
    | "agentPromptCache"
    | "contextPromptCache"
    | "summaryProviderId"
    | "summaryModel"
    | "showMessageTimestamps"
    | "injectCurrentTime"
    | "multiMessageEnabled"
    | "voiceMessagesEnabled"
    | "voiceMessageBudgetTokens"
  >
>;



function uid() {
  return "m_" + Math.random().toString(36).slice(2, 10);
}

function timestampNow() {
  return Date.now();
}

function createDefaultAgent(): Agent {
  const now = Date.now();
  return {
    id: newAgentId(),
    name: "Default agent",
    profile: "",
    memory: "",
    instructions: "",
    worldBook: "",
    createdAt: now,
    updatedAt: now,
  };
}

function createEmptyConversation(agentId: string | null): Conversation {
  const now = Date.now();
  const current = loadCurrent();
  return {
    id: newConversationId(),
    agentId,
    providerId: current.providerId,
    model: current.model,
    temperature: DEFAULT_TEMPERATURE,
    reasoningEnabled: DEFAULT_REASONING_ENABLED,
    thinkingMode: DEFAULT_THINKING_MODE,
    thinkingEffort: DEFAULT_THINKING_EFFORT,
    thinkingBudgetTokens: DEFAULT_THINKING_BUDGET_TOKENS,
    agentPromptCache: DEFAULT_AGENT_PROMPT_CACHE,
    contextPromptCache: DEFAULT_CONTEXT_PROMPT_CACHE,
    summaryProviderId: null,
    summaryModel: null,
    showMessageTimestamps: false,
    injectCurrentTime: false,
    multiMessageEnabled: DEFAULT_MULTI_MESSAGE_ENABLED,
    voiceMessagesEnabled: DEFAULT_VOICE_MESSAGES_ENABLED,
    voiceMessageBudgetTokens: DEFAULT_VOICE_MESSAGE_BUDGET_TOKENS,
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function titleFromMessage(text: string): string {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return "New chat";
  return clean.length > 36 ? `${clean.slice(0, 36)}...` : clean;
}

function titleFromPromptMessages(messages: StoredMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  return firstUser
    ? titleFromMessage(contentBlocksToPlainText(firstUser.content, true))
    : "New chat";
}

function normalizeGeneratedTitle(text: string): string {
  const clean = text
    .trim()
    .split("\n")[0]
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ");
  if (!clean) return "New chat";
  return clean.length > 44 ? `${clean.slice(0, 44)}...` : clean;
}

function stripTransientContentBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "voice") return block;
    if (block.status === "error") {
      return {
        type: "voice",
        id: block.id,
        text: block.text,
        status: "error",
        audioRef: block.audioRef,
        error: block.error,
      };
    }
    if (block.audioRef) {
      return {
        type: "voice",
        id: block.id,
        text: block.text,
        status: "ready",
        audioRef: block.audioRef,
      };
    }
    if (isPersistentAudioUrl(block.audioUrl)) {
      return {
        type: "voice",
        id: block.id,
        text: block.text,
        status: "ready",
        audioUrl: block.audioUrl,
      };
    }
    return {
      type: "voice",
      id: block.id,
      text: block.text,
    };
  });
}

function stripTransientAlternative(
  alternative: StoredMessageAlternative,
): StoredMessageAlternative {
  return {
    ...alternative,
    content: stripTransientContentBlocks(alternative.content),
  };
}

function stripTransient(message: UIMessage): StoredMessage {
  const alternatives = message.alternatives?.map(stripTransientAlternative);
  return {
    id: message.id,
    role: message.role,
    model: message.model,
    content: stripTransientContentBlocks(message.content),
    createdAt: message.createdAt,
    usage: message.usage,
    ...(alternatives && alternatives.length > 1
      ? {
          alternatives,
          activeAlternativeIndex: normalizeAlternativeIndex(
            message.activeAlternativeIndex,
            alternatives.length,
          ),
        }
      : {}),
  };
}

function stripTransientConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map(stripTransient),
  };
}

function normalizeAlternativeIndex(value: number | undefined, count: number): number {
  if (count <= 0) return 0;
  if (value === undefined || !Number.isFinite(value)) return count - 1;
  return Math.max(0, Math.min(count - 1, Math.trunc(value)));
}

function messageAlternativeFromMessage(
  message: StoredMessage,
): StoredMessageAlternative {
  return {
    id: message.id,
    model: message.model,
    content: message.content,
    createdAt: message.createdAt,
    usage: message.usage,
  };
}

function messageAlternatives(message: StoredMessage): StoredMessageAlternative[] {
  if (message.role !== "assistant") return [];
  const alternatives =
    message.alternatives?.filter(
      (alternative) =>
        typeof alternative.id === "string" &&
        Array.isArray(alternative.content),
    ) ?? [];
  return alternatives.length > 0
    ? alternatives
    : [messageAlternativeFromMessage(message)];
}

function assistantAlternativeCount(message: StoredMessage): number {
  return messageAlternatives(message).length;
}

function activeAssistantAlternativeIndex(message: StoredMessage): number {
  return normalizeAlternativeIndex(
    message.activeAlternativeIndex,
    assistantAlternativeCount(message),
  );
}

function syncActiveAssistantAlternative(message: StoredMessage): StoredMessage {
  if (message.role !== "assistant") return message;
  const alternatives = messageAlternatives(message);
  if (alternatives.length <= 1) {
    const nextMessage = { ...message };
    delete nextMessage.alternatives;
    delete nextMessage.activeAlternativeIndex;
    return nextMessage;
  }
  const activeIndex = normalizeAlternativeIndex(
    message.activeAlternativeIndex,
    alternatives.length,
  );
  const nextAlternatives = alternatives.map((alternative, index) =>
    index === activeIndex
      ? {
          ...alternative,
          model: message.model,
          content: message.content,
          createdAt: message.createdAt,
          usage: message.usage,
        }
      : alternative,
  );
  return {
    ...message,
    alternatives: nextAlternatives,
    activeAlternativeIndex: activeIndex,
  };
}

function switchAssistantAlternative(
  message: StoredMessage,
  direction: -1 | 1,
): StoredMessage {
  const alternatives = messageAlternatives(message);
  if (alternatives.length <= 1) return message;
  const activeIndex = normalizeAlternativeIndex(
    message.activeAlternativeIndex,
    alternatives.length,
  );
  const nextIndex = normalizeAlternativeIndex(
    activeIndex + direction,
    alternatives.length,
  );
  const nextAlternative = alternatives[nextIndex];
  return {
    ...message,
    model: nextAlternative.model,
    content: nextAlternative.content,
    createdAt: nextAlternative.createdAt,
    usage: nextAlternative.usage,
    alternatives,
    activeAlternativeIndex: nextIndex,
  };
}

function appendAssistantAlternative(
  message: StoredMessage,
  alternative: StoredMessageAlternative,
): StoredMessage {
  const alternatives = [...messageAlternatives(message), alternative];
  return {
    ...message,
    model: alternative.model,
    content: alternative.content,
    createdAt: alternative.createdAt,
    usage: alternative.usage,
    alternatives,
    activeAlternativeIndex: alternatives.length - 1,
  };
}

function collectObjectAudioUrls(conversations: Conversation[]): Set<string> {
  const urls = new Set<string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      for (const block of message.content) {
        if (
          block.type === "voice" &&
          block.audioUrl?.startsWith("blob:")
        ) {
          urls.add(block.audioUrl);
        }
      }
    }
  }
  return urls;
}

function isPersistentAudioUrl(url: string | undefined): url is string {
  return Boolean(url?.startsWith("data:audio/"));
}

function canUseSyncBlobStorage(settings: SyncSettings): boolean {
  return Boolean(settings.endpoint.trim() && settings.syncCode.trim().length >= 8);
}

function newVoiceBlobId(voiceBlockId: string): string {
  const safeVoiceId = voiceBlockId.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `voice_${safeVoiceId}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function audioBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Could not read generated audio."));
      }
    };
    reader.onerror = () => reject(new Error("Could not read generated audio."));
    reader.readAsDataURL(blob);
  });
}

function assistantMessagesFromContentSets(
  assistantMessage: UIMessage,
  contentSets: ContentBlock[][],
  usage: UIMessage["usage"],
): StoredMessage[] {
  const sets = contentSets.length > 0 ? contentSets : [[]];
  const lastIndex = sets.length - 1;

  return sets.map((content, index) => ({
    id: index === 0 ? assistantMessage.id : uid(),
    role: "assistant" as const,
    model: assistantMessage.model,
    content,
    createdAt: assistantMessage.createdAt,
    usage: index === lastIndex ? usage : undefined,
  }));
}

function textFromContent(content: ContentBlock[]): string {
  return contentBlocksToPlainText(content);
}

function requestContentFromBlocks(content: ContentBlock[]): string | ChatContentPart[] {
  const parts = contentBlocksToPromptParts(content);
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function sanitizeToolName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "mcp_tool";
}

function uniqueToolName(
  server: McpServerConfig,
  tool: McpToolSummary,
  used: Set<string>,
): string {
  const serverPart = sanitizeToolName(server.name || server.id);
  const toolPart = sanitizeToolName(tool.name);
  const base = sanitizeToolName(`${serverPart}__${toolPart}`).slice(0, 64);
  let candidate = base;
  let counter = 2;

  while (used.has(candidate)) {
    const suffix = `_${counter}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    counter += 1;
  }

  used.add(candidate);
  return candidate;
}

function normalizeToolParameters(schema: unknown): Record<string, unknown> {
  const parameters = isRecord(schema) ? { ...schema } : {};
  if (typeof parameters.type !== "string") parameters.type = "object";
  if (!isRecord(parameters.properties)) parameters.properties = {};
  return parameters;
}

async function prepareMcpTools(
  servers: McpServerConfig[],
): Promise<ActiveMcpTool[]> {
  const enabledServers = servers.filter(
    (server) => server.enabled && server.url.trim(),
  );
  if (enabledServers.length === 0) return [];

  const usedNames = new Set<string>();
  const listed = await Promise.all(
    enabledServers.map(async (server) => ({
      server,
      result: await listMcpServerTools(server),
    })),
  );

  return listed.flatMap(({ server, result }) =>
    result.tools.map((tool): ActiveMcpTool => {
      const functionName = uniqueToolName(server, tool, usedNames);
      const displayName = `${server.name || server.id}/${tool.name}`;
      return {
        functionName,
        server,
        sessionId: result.sessionId,
        toolName: tool.name,
        displayName,
        chatTool: {
          type: "function",
          function: {
            name: functionName,
            description: [
              `MCP tool ${displayName}.`,
              tool.description ?? "",
            ]
              .filter(Boolean)
              .join(" "),
            parameters: normalizeToolParameters(tool.inputSchema),
          },
        },
      };
    }),
  );
}

const CHAT_HISTORY_SEARCH_TOOL: ChatTool = {
  type: "function",
  function: {
    name: CHAT_HISTORY_SEARCH_TOOL_NAME,
    description:
      "Search saved Cedar Chat conversation history. Use scope='current' to search this chat window, or scope='all' to search across all chat windows.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to find in conversation titles, messages, attachments, or tool output.",
        },
        scope: {
          type: "string",
          enum: ["current", "all"],
          description: "Search only the current chat window or all saved chat windows.",
        },
        maxResults: {
          type: "number",
          description: `Maximum results to return, up to ${MAX_CHAT_HISTORY_SEARCH_LIMIT}.`,
        },
      },
      required: ["query"],
    },
  },
};

function normalizeChatHistorySearchScope(value: unknown): ChatHistorySearchScope {
  return value === "current" ? "current" : "all";
}

function normalizeChatHistorySearchLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CHAT_HISTORY_SEARCH_LIMIT;
  }
  return Math.max(
    1,
    Math.min(MAX_CHAT_HISTORY_SEARCH_LIMIT, Math.round(value)),
  );
}

function chatHistorySearchCorpus(
  conversations: Conversation[],
  currentConversationId: string,
  currentPromptMessages: StoredMessage[],
): Conversation[] {
  let replacedCurrent = false;
  const next = conversations.map((conversation) => {
    if (conversation.id !== currentConversationId) return conversation;
    replacedCurrent = true;
    return {
      ...conversation,
      messages: currentPromptMessages,
    };
  });
  return replacedCurrent ? next : conversations;
}

function formatSearchResultTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatChatHistorySearchToolResult(
  query: string,
  scope: ChatHistorySearchScope,
  results: SearchResult[],
  titleMatches: Conversation[],
): string {
  return JSON.stringify(
    {
      query,
      scope,
      count: results.length + titleMatches.length,
      messageResultCount: results.length,
      titleMatchCount: titleMatches.length,
      titleMatches: titleMatches.map((conversation) => ({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        messageCount: conversation.messages.length,
        updatedAt: formatSearchResultTime(conversation.updatedAt),
      })),
      results: results.map((result) => ({
        conversationId: result.conversationId,
        conversationTitle: result.conversationTitle,
        messageId: result.messageId,
        messageNumber: result.messageIndex + 1,
        role: result.messageRole,
        createdAt: formatSearchResultTime(result.createdAt),
        snippet: result.matchText,
      })),
    },
    null,
    2,
  );
}

function runChatHistorySearchTool(
  args: Record<string, unknown>,
  conversations: Conversation[],
  currentConversationId: string,
): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return JSON.stringify(
      {
        error: "query is required",
        results: [],
      },
      null,
      2,
    );
  }

  const scope = normalizeChatHistorySearchScope(args.scope);
  const maxResults = normalizeChatHistorySearchLimit(args.maxResults);
  const corpus =
    scope === "current"
      ? conversations.filter((conversation) => conversation.id === currentConversationId)
      : conversations;
  const results = searchConversations(corpus, query, maxResults);
  const messageMatchIds = new Set(results.map((result) => result.conversationId));
  const titleMatches = searchConversationTitles(corpus, query)
    .filter((conversation) => !messageMatchIds.has(conversation.id))
    .slice(0, maxResults);
  return formatChatHistorySearchToolResult(query, scope, results, titleMatches);
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : { value: parsed };
}

function formatToolInput(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw || "{}";
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function limitMcpResult(text: string): string {
  if (text.length <= MAX_MCP_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_MCP_RESULT_CHARS)}\n\n[MCP result truncated after ${MAX_MCP_RESULT_CHARS.toLocaleString()} characters.]`;
}

function limitToolBlockText(text: string): string {
  if (text.length <= MAX_TOOL_BLOCK_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_BLOCK_CHARS)}\n\n[Preview truncated.]`;
}

function formatMcpToolResult(result: unknown): string {
  const root = isRecord(result) ? result : {};
  const content = root.content;
  const parts = Array.isArray(content)
    ? content.map((item) => {
        if (!isRecord(item)) return safeStringify(item);
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return safeStringify(item);
      })
    : [];
  const structured = root.structuredContent;
  const structuredText =
    structured === undefined ? "" : `Structured content:\n${safeStringify(structured)}`;
  const body = [...parts, structuredText].filter(Boolean).join("\n\n");
  const fallback = body || safeStringify(result);
  const prefix =
    isRecord(result) && result.isError === true
      ? "MCP tool reported an error.\n\n"
      : "";
  return limitMcpResult(`${prefix}${fallback}`);
}

function mergeUsage(
  previous: UIMessage["usage"],
  next: UIMessage["usage"],
): UIMessage["usage"] {
  if (!next) return previous;
  if (!previous) return next;
  return {
    inputTokens: previous.inputTokens + next.inputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    cachedInputTokens:
      (previous.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
    cacheWriteInputTokens:
      (previous.cacheWriteInputTokens ?? 0) +
      (next.cacheWriteInputTokens ?? 0),
  };
}

function isOpus46Or47Model(modelName: string | null): boolean {
  const normalized = modelName?.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "";
  return /opus-?4-?[67](?:-|$)/.test(normalized);
}

function tokenCost(tokens: number, pricePerMillion: number): number {
  return (tokens / TOKENS_PER_MILLION) * pricePerMillion;
}

function formatUsd(amount: number): string {
  if (amount === 0) return "$0.0000";
  if (amount < 0.001) return `$${amount.toFixed(6)}`;
  if (amount < 0.1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

function formatCostRangeLabel(minCost: number, maxCost: number): string {
  return Math.abs(maxCost - minCost) < 0.000001
    ? `≈ ${formatUsd(maxCost)}`
    : `≈ ${formatUsd(minCost)}-${formatUsd(maxCost)}`;
}

function estimateMessageCost(
  modelName: string | null,
  usage: NonNullable<UIMessage["usage"]>,
): { label: string; title: string; minCost: number; maxCost: number } | null {
  const modelMatched = isOpus46Or47Model(modelName);
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const cacheWriteInputTokens = Math.max(0, usage.cacheWriteInputTokens ?? 0);
  const cacheTokens = cachedInputTokens + cacheWriteInputTokens;
  const inputTokens = Math.max(0, usage.inputTokens);
  const outputTokens = Math.max(0, usage.outputTokens);

  const inputIncludesCache = cacheTokens > 0 && inputTokens >= cacheTokens;
  const standardInputTokens = inputIncludesCache
    ? inputTokens - cacheTokens
    : inputTokens;

  const standardInputCost = tokenCost(
    standardInputTokens,
    OPUS_46_47_PRICING_PER_MTOK.input,
  );
  const cacheReadCost = tokenCost(
    cachedInputTokens,
    OPUS_46_47_PRICING_PER_MTOK.cacheRead,
  );
  const cacheWriteCost5m = tokenCost(
    cacheWriteInputTokens,
    OPUS_46_47_PRICING_PER_MTOK.cacheWrite5m,
  );
  const cacheWriteCost1h = tokenCost(
    cacheWriteInputTokens,
    OPUS_46_47_PRICING_PER_MTOK.cacheWrite1h,
  );
  const outputCost = tokenCost(outputTokens, OPUS_46_47_PRICING_PER_MTOK.output);
  const minCost =
    standardInputCost + cacheReadCost + cacheWriteCost5m + outputCost;
  const maxCost =
    standardInputCost + cacheReadCost + cacheWriteCost1h + outputCost;
  const label = formatCostRangeLabel(minCost, maxCost);

  return {
    label,
    minCost,
    maxCost,
    title:
      "Claude Opus 4.6/4.7 standard API estimate" +
      (modelMatched ? "" : " (model name was not recognized, using Opus pricing)") +
      ". " +
      `input ${standardInputTokens} @ $5/M, ` +
      `cache hit ${cachedInputTokens} @ $0.50/M, ` +
      `cache write ${cacheWriteInputTokens} @ $6.25-$10/M, ` +
      `output ${outputTokens} @ $25/M.`,
  };
}

function estimateConversationCost(
  messages: UIMessage[],
  fallbackModelName: string | null,
): { label: string; title: string; count: number } | null {
  let minCost = 0;
  let maxCost = 0;
  let count = 0;

  for (const message of messages) {
    if (!message.usage || message.streaming) continue;
    const estimate = estimateMessageCost(
      message.model ?? fallbackModelName,
      message.usage,
    );
    if (!estimate) continue;
    minCost += estimate.minCost;
    maxCost += estimate.maxCost;
    count += 1;
  }

  if (count === 0) return null;

  return {
    label: formatCostRangeLabel(minCost, maxCost),
    title:
      `Total estimate for ${count} completed response${count === 1 ? "" : "s"}. ` +
      "Uses the same Claude Opus 4.6/4.7 pricing estimate shown below each message.",
    count,
  };
}

function cacheControlForTTL(
  cacheTTLMode: ClaudePromptCacheTTL,
): ChatTextContentPart["cache_control"] | undefined {
  const ttl = promptCacheTTL(cacheTTLMode);
  if (!ttl) return undefined;
  return {
    type: "ephemeral",
    ...(ttl === "1h" ? { ttl } : {}),
  };
}

function withCacheControlOnContent(
  content: ChatMessage["content"],
  cacheTTLMode: ClaudePromptCacheTTL,
  trailingPart?: ChatTextContentPart,
): ChatMessage["content"] {
  const cacheControl = cacheControlForTTL(cacheTTLMode);
  if (!cacheControl) return content;

  if (content == null) {
    return trailingPart ? [trailingPart] : "";
  }

  if (typeof content === "string") {
    return [
      { type: "text", text: content, cache_control: cacheControl },
      ...(trailingPart ? [trailingPart] : []),
    ];
  }

  const next: ChatContentPart[] = content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { ...part },
  );
  const textIndex = next.findLastIndex((part) => part.type === "text");
  if (textIndex === -1) {
    next.push({ type: "text", text: "", cache_control: cacheControl });
    if (trailingPart) next.push(trailingPart);
    return next;
  }

  const part = next[textIndex];
  if (part.type === "text") {
    next[textIndex] = { ...part, cache_control: cacheControl };
  }
  if (trailingPart) next.push(trailingPart);
  return next;
}

function withCacheControlOnLastMessage(
  messages: ChatMessage[],
  cacheTTLMode: ClaudePromptCacheTTL,
  trailingPart?: ChatTextContentPart,
): ChatMessage[] {
  if (messages.length === 0) return messages;
  const lastIndex = messages.length - 1;
  return messages.map((message, index) =>
    index === lastIndex
      ? {
          ...message,
          content: withCacheControlOnContent(
            message.content,
            cacheTTLMode,
            trailingPart,
          ),
        }
      : message,
  );
}

async function generateConversationTitle(
  provider: ReturnType<typeof createProvider>,
  model: string,
  promptMessages: StoredMessage[],
  assistantText: string,
): Promise<string> {
  const conversationText = [
    ...promptMessages.map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `${label}: ${contentBlocksToPlainText(message.content, true)}`;
    }),
    `Assistant: ${assistantText}`,
  ].join("\n\n");

  const response = await provider.sendMessage({
    model,
    maxTokens: 64,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content:
          "Create a concise chat window title for the conversation below. " +
          "Return only the title, without quotes. Use the conversation's main language. " +
          "Keep it under 8 words.\n\n" +
          conversationText.slice(0, 8000),
      },
    ],
  });

  return normalizeGeneratedTitle(contentBlocksToPlainText(response.content, true));
}

async function generatePinSummary(
  provider: ReturnType<typeof createProvider>,
  model: string,
  messagesToSummarize: StoredMessage[],
  existingSummary?: string | null,
): Promise<string> {
  const conversationText = messagesToSummarize
    .map((message) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `${label}: ${contentBlocksToPlainText(message.content, true)}`;
    })
    .join("\n\n");

  const contextPrefix = existingSummary
    ? `Previous summary:\n${existingSummary}\n\nNew messages since last summary:\n`
    : "";

  const response = await provider.sendMessage({
    model,
    maxTokens: 1500,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content:
          "Your task is to compress this conversation into a structured note, so the AI can continue the conversation later without seeing the original messages. " +
          "Both factual content AND the emotional/tonal texture must be preserved — but as structured observations, NOT as narrative or first-person rewriting.\n\n" +
          "First, think inside <analysis></analysis>: go through the conversation chronologically, noting topic shifts, emotional shifts, and tone changes.\n\n" +
          "Then output the final note inside <summary></summary> with these sections (use the conversation's main language for content; keep headers in English):\n\n" +
          "1. **Setting**: Who is talking to whom (role/persona if any), what kind of conversation this is (e.g. casual chat, roleplay, debugging, emotional support). 1-2 lines.\n\n" +
          "2. **Key Facts & Decisions**: Bullet list of facts, names, plot points, decisions, or established context the AI must remember.\n\n" +
          "3. **User Style & Preferences**: How the user writes and wants to be talked to — formality, length, language quirks, things to avoid. Stable traits only.\n\n" +
          "4. **Emotional Arc**: Bullet list, third person, in chronological order. Each bullet = one shift, format: `[turn marker] user/assistant tone shifted from X to Y, because Z`.\n\n" +
          "5. **Current Emotional State**: One paragraph (2-3 sentences) describing the user's current mood, what tone the assistant has been using, and what register the next reply should match. This is the most important section for continuity — be specific.\n\n" +
          "6. **Recent Turns**: List the last 3-5 exchanges. For each: `User (tone): paraphrased content` and `Assistant (tone): paraphrased content`. Tone in parentheses captures the feel (e.g. 'playful', 'pleading', 'careful', 'matter-of-fact'). Content stays factual.\n\n" +
          "7. **Pending**: What was just asked / what the AI was about to do, or 'awaiting user'.\n\n" +
          "Rules:\n" +
          "- Always third person. Never write as the user or the character. Never first-person narration.\n" +
          "- Emotion is described, not performed. Say 'user expressed frustration', not 'I was so frustrated...'\n" +
          "- Target 400-700 tokens for the <summary> block. Emotional arc deserves the extra space.\n" +
          "- Drop greetings and pure small talk, but KEEP moments where tone visibly shifted.\n" +
          "- Output only the <analysis> and <summary> blocks. No preamble.\n\n" +
          "Conversation:\n" +
          contextPrefix +
          conversationText.slice(0, 50000),
      },
    ],
  });

  const raw = contentBlocksToPlainText(response.content, true);
  const match = raw.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match ? match[1] : raw).trim();
}


function assistantBlocksFromText(
  thinkingText: string,
  responseText: string,
  voiceMessagesEnabled: boolean,
  voiceBudgetTokens: number,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (thinkingText) blocks.push({ type: "thinking", text: thinkingText });

  const textBlocks = voiceMessagesEnabled
    ? parseVoiceMessageBlocks(responseText, voiceBudgetTokens)
    : responseText
      ? [{ type: "text" as const, text: responseText }]
      : [];
  blocks.push(...textBlocks);
  return blocks;
}

function assistantBlocksWithTools(
  thinkingText: string,
  responseText: string,
  toolBlocks: ToolBlock[],
  voiceMessagesEnabled: boolean,
  voiceBudgetTokens: number,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (thinkingText) blocks.push({ type: "thinking", text: thinkingText });
  blocks.push(...toolBlocks);
  blocks.push(
    ...assistantBlocksFromText(
      "",
      responseText,
      voiceMessagesEnabled,
      voiceBudgetTokens,
    ),
  );
  return blocks;
}

function stripMultiMessageTags(text: string): string {
  return text.replace(/<\/?message>/gi, "");
}

function splitMultiMessageText(text: string): string[] {
  if (!text.trim()) return [];

  const messagePattern = /<message>([\s\S]*?)<\/message>/gi;
  const parts: string[] = [];
  let cursor = 0;

  for (const match of text.matchAll(messagePattern)) {
    const start = match.index ?? 0;
    const before = text.slice(cursor, start).trim();
    if (before) parts.push(stripMultiMessageTags(before).trim());

    const messageText = match[1].trim();
    if (messageText) parts.push(messageText);

    cursor = start + match[0].length;
  }

  const after = text.slice(cursor).trim();
  if (after) parts.push(stripMultiMessageTags(after).trim());

  const cleaned = parts.filter(Boolean);
  return cleaned.length > 0 ? cleaned : [stripMultiMessageTags(text).trim()];
}

function assistantMessageContentSets(
  thinkingText: string,
  responseText: string,
  toolBlocks: ToolBlock[],
  multiMessageEnabled: boolean,
  voiceMessagesEnabled: boolean,
  voiceBudgetTokens: number,
): ContentBlock[][] {
  const messageTexts = multiMessageEnabled
    ? splitMultiMessageText(responseText)
    : [responseText];

  if (messageTexts.length <= 1) {
    return [
      assistantBlocksWithTools(
        thinkingText,
        messageTexts[0] ?? responseText,
        toolBlocks,
        voiceMessagesEnabled,
        voiceBudgetTokens,
      ),
    ];
  }

  return messageTexts.map((messageText, index) =>
    assistantBlocksWithTools(
      index === 0 ? thinkingText : "",
      messageText,
      index === 0 ? toolBlocks : [],
      voiceMessagesEnabled,
      voiceBudgetTokens,
    ),
  );
}

function parseVoiceMessageBlocks(
  text: string,
  budgetTokens: number,
): ContentBlock[] {
  if (!text) return [];

  const blocks: ContentBlock[] = [];
  const normalizedText = normalizeVoiceTranscriptMarkers(text);
  const voicePattern = /<voice>([\s\S]*?)<\/voice>/gi;
  let cursor = 0;
  let spentTokens = 0;

  for (const match of normalizedText.matchAll(voicePattern)) {
    const start = match.index ?? 0;
    const before = normalizedText.slice(cursor, start);
    if (before) blocks.push({ type: "text", text: before });

    const voiceText = match[1].trim();
    const tokenEstimate = estimateTokens(voiceText);
    if (
      voiceText &&
      budgetTokens > 0 &&
      spentTokens + tokenEstimate <= budgetTokens
    ) {
      blocks.push({
        type: "voice",
        id: uid(),
        text: voiceText,
        status: "pending",
      });
      spentTokens += tokenEstimate;
    } else if (voiceText) {
      blocks.push({ type: "text", text: voiceText });
    }

    cursor = start + match[0].length;
  }

  const after = normalizedText.slice(cursor);
  if (after) blocks.push({ type: "text", text: after });

  return mergeAdjacentTextBlocks(blocks).filter(
    (block) => block.type !== "text" || block.text.trim(),
  );
}

function normalizeVoiceTranscriptMarkers(text: string): string {
  const markerPattern = /^\s*\[Voice message transcript\]\s*\n?/im;
  if (!markerPattern.test(text)) return text;
  return text.replace(markerPattern, "<voice>") + "</voice>";
}

function mergeAdjacentTextBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const merged: ContentBlock[] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (block.type === "text" && previous?.type === "text") {
      previous.text += block.text;
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function contentHasPendingVoice(content: ContentBlock[]): boolean {
  return content.some((block) => block.type === "voice" && block.status === "pending");
}

function canSynthesizeSpeechWithProfile(
  profile: ReturnType<typeof getActiveTtsProfile>,
): boolean {
  return Boolean(
    profile && (profile.provider !== "edge" || profile.baseUrl.trim()),
  );
}

function formatMessageTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay
      ? {}
      : {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBeijingClock(now = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

function weatherToolScore(server: McpServerConfig, tool: McpToolSummary): number {
  const haystack = [
    server.name,
    server.url,
    tool.name,
    tool.description ?? "",
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;
  if (haystack.includes("weather") || haystack.includes("天气")) score += 4;
  if (haystack.includes("forecast") || haystack.includes("预报")) score += 2;
  if (haystack.includes("current")) score += 1;
  return score;
}

function firstRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function buildWeatherArgs(tool: McpToolSummary): Record<string, unknown> | null {
  const schema = firstRecord(tool.inputSchema);
  const properties = firstRecord(schema.properties);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const propertyNames = Object.keys(properties);
  const args: Record<string, unknown> = {};
  const locationKeys = [
    "location",
    "city",
    "place",
    "query",
    "q",
    "address",
  ];
  const locationKey =
    propertyNames.find((name) => locationKeys.includes(name.toLowerCase())) ??
    required.find((name) => locationKeys.includes(name.toLowerCase()));

  if (locationKey) {
    args[locationKey] = WEATHER_LOCATION;
  } else {
    const stringKeys = propertyNames.filter((name) => {
      const property = firstRecord(properties[name]);
      return property.type === "string";
    });
    if (stringKeys.length === 1) {
      args[stringKeys[0]] = WEATHER_LOCATION;
    } else if (required.length === 0 && propertyNames.length === 0) {
      return {};
    }
  }

  const missingRequired = required.filter((name) => !(name in args));
  return missingRequired.length === 0 ? args : null;
}

function weatherTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(weatherTextFromUnknown).join(" ");
  if (!isRecord(value)) return "";
  const preferredKeys = [
    "condition",
    "weather",
    "summary",
    "description",
    "text",
    "status",
  ];
  const preferred = preferredKeys
    .map((key) => weatherTextFromUnknown(value[key]))
    .filter(Boolean)
    .join(" ");
  return preferred || Object.values(value).map(weatherTextFromUnknown).join(" ");
}

function weatherLabelFromText(text: string): string | null {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return null;

  const chineseMatch = compact.match(
    /(晴|多云|阴|小雨|中雨|大雨|阵雨|雷雨|暴雨|小雪|中雪|大雪|雨夹雪|雾|霾)/,
  );
  if (chineseMatch) return chineseMatch[1];

  const lower = compact.toLowerCase();
  if (lower.includes("thunder")) return "雷雨";
  if (lower.includes("snow")) return "小雪";
  if (lower.includes("rain") || lower.includes("shower")) return "小雨";
  if (lower.includes("overcast")) return "阴";
  if (lower.includes("cloud")) return "多云";
  if (lower.includes("fog") || lower.includes("mist")) return "雾";
  if (lower.includes("clear") || lower.includes("sunny")) return "晴";

  return null;
}

function weatherLabelFromMcpResult(result: unknown): string | null {
  const root = firstRecord(result);
  const structured = weatherLabelFromText(
    weatherTextFromUnknown(root.structuredContent),
  );
  if (structured) return structured;

  const content = root.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const record = firstRecord(item);
        return typeof record.text === "string" ? record.text : weatherTextFromUnknown(item);
      })
      .join(" ");
    return weatherLabelFromText(text);
  }

  return weatherLabelFromText(weatherTextFromUnknown(result));
}

async function fetchWeatherLabelFromMcp(
  servers: McpServerConfig[],
): Promise<string | null> {
  const enabledServers = servers.filter(
    (server) => server.enabled && server.url.trim(),
  );
  if (enabledServers.length === 0) return null;

  const candidates: Array<{
    server: McpServerConfig;
    sessionId?: string;
    tool: McpToolSummary;
    score: number;
  }> = [];

  for (const server of enabledServers) {
    try {
      const result = await listMcpServerTools(server);
      for (const tool of result.tools) {
        const score = weatherToolScore(server, tool);
        if (score > 0) {
          candidates.push({
            server,
            sessionId: result.sessionId,
            tool,
            score,
          });
        }
      }
    } catch {
      // Weather is decorative here; failed MCP servers should not disturb chat.
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const candidate of candidates) {
    const args = buildWeatherArgs(candidate.tool);
    if (!args) continue;
    try {
      const result = await callMcpTool(
        candidate.server,
        candidate.tool.name,
        args,
        candidate.sessionId,
      );
      const label = weatherLabelFromMcpResult(result.result);
      if (label) return label;
    } catch {
      // Try the next weather-looking tool.
    }
  }

  return null;
}

function currentTimePromptContent(now = new Date()): ChatTextContentPart {
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "local browser time";
  const formatted = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(now);

  return {
    type: "text",
    text:
      "# Current Time\n" +
      `Current local date and time: ${formatted}\n` +
      `Time zone: ${timeZone}\n` +
      "Use this timestamp as the reference for relative time expressions such as today, tomorrow, yesterday, now, and later.",
  };
}

function voiceMessagePromptContent(budgetTokens: number): ChatTextContentPart {
  return {
    type: "text",
    text:
      "# Voice Messages\n" +
      "You may choose to send voice content when it would feel more natural, warm, expressive, or concise than plain text.\n" +
      "To send voice, wrap only the spoken segment in <voice>...</voice>. Text outside those tags stays as normal written chat.\n" +
      "You can make the whole reply a voice message by returning only one <voice>...</voice> segment, or mix text and one or more voice segments.\n" +
      `Keep the total text inside all <voice> tags within about ${budgetTokens} tokens. ` +
      "Do not mention these tags to the user. Do not put code, tables, long lists, or tool output inside voice tags.",
  };
}

function multiMessagePromptContent(): ChatTextContentPart {
  return {
    type: "text",
    text:
      "# Multiple Chat Messages\n" +
      "You may split a natural chat reply into multiple short message bubbles, similar to an instant messaging app.\n" +
      "To split the reply, wrap each bubble in <message>...</message>. Use two to five bubbles when it improves pacing, and use a normal single reply when one bubble is clearer.\n" +
      "Do not mention these tags to the user. Keep code blocks, tables, and tool output in one bubble.",
  };
}

function requestSystemContent(
  agent: Agent | null,
  agentPromptCache: ClaudePromptCacheTTL,
  cacheEnabled: boolean,
  injectCurrentTime: boolean,
  contextPromptCache: ClaudePromptCacheTTL,
  multiMessageEnabled: boolean,
  voiceMessagesEnabled: boolean,
  voiceMessageBudgetTokens: number,
): ChatTextContentPart[] | undefined {
  const parts = agentSystemContent(agent, agentPromptCache, cacheEnabled) ?? [];
  if (injectCurrentTime && contextPromptCache === "off") {
    parts.push(currentTimePromptContent());
  }
  if (multiMessageEnabled) {
    parts.push(multiMessagePromptContent());
  }
  if (voiceMessagesEnabled) {
    parts.push(voiceMessagePromptContent(voiceMessageBudgetTokens));
  }
  return parts.length > 0 ? parts : undefined;
}

function normalizeAgent(agent: Agent): Agent {
  return {
    ...agent,
    instructions: agent.instructions ?? "",
    worldBook: agent.worldBook ?? "",
  };
}

function isOpenRouterClaude(
  provider: ProviderConfig | null,
  model: string | null,
): boolean {
  if (!provider || !model) return false;
  const baseUrl = provider.baseUrl.toLowerCase();
  const modelId = model.toLowerCase();
  return (
    baseUrl.includes("openrouter.ai") &&
    (modelId.includes("anthropic/") || modelId.includes("claude"))
  );
}

function normalizeClaudePromptCacheMode(value: unknown): ClaudePromptCacheMode {
  switch (value) {
    case "5m":
    case "agent-5m":
      return "agent-5m";
    case "1h":
    case "agent-1h":
      return "agent-1h";
    case "context-5m":
      return "context-5m";
    case "context-1h":
      return "context-1h";
    default:
      return DEFAULT_LEGACY_CLAUDE_PROMPT_CACHE;
  }
}

function normalizeClaudePromptCacheTTL(
  value: unknown,
  fallback: ClaudePromptCacheTTL = "off",
): ClaudePromptCacheTTL {
  return value === "5m" || value === "1h" ? value : fallback;
}

function splitLegacyPromptCacheMode(
  value: unknown,
): {
  agentPromptCache: ClaudePromptCacheTTL;
  contextPromptCache: ClaudePromptCacheTTL;
} {
  const mode = normalizeClaudePromptCacheMode(value);
  switch (mode) {
    case "agent-5m":
      return { agentPromptCache: "5m", contextPromptCache: "off" };
    case "agent-1h":
      return { agentPromptCache: "1h", contextPromptCache: "off" };
    case "context-5m":
      return { agentPromptCache: "off", contextPromptCache: "5m" };
    case "context-1h":
      return { agentPromptCache: "off", contextPromptCache: "1h" };
    default:
      return { agentPromptCache: "off", contextPromptCache: "off" };
  }
}

function normalizeThinkingMode(value: unknown): ThinkingMode {
  return value === "budget" ? "budget" : DEFAULT_THINKING_MODE;
}

function normalizeThinkingEffort(value: unknown): ThinkingEffort {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return DEFAULT_THINKING_EFFORT;
  }
}

function normalizeTemperature(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(2, value))
    : DEFAULT_TEMPERATURE;
}

function normalizeThinkingBudgetTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(64000, Math.round(value)))
    : DEFAULT_THINKING_BUDGET_TOKENS;
}

function normalizeVoiceMessageBudgetTokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(4000, Math.round(value)))
    : DEFAULT_VOICE_MESSAGE_BUDGET_TOKENS;
}

function legacyGlobalCacheMode(): ClaudePromptCacheMode {
  try {
    const raw = localStorage.getItem("cedar-chat.preferences");
    if (!raw) return DEFAULT_LEGACY_CLAUDE_PROMPT_CACHE;
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed)
      ? normalizeClaudePromptCacheMode(parsed.claudePromptCache)
      : DEFAULT_LEGACY_CLAUDE_PROMPT_CACHE;
  } catch {
    return DEFAULT_LEGACY_CLAUDE_PROMPT_CACHE;
  }
}

function promptCacheTTL(cacheTTLMode: ClaudePromptCacheTTL): "5m" | "1h" | null {
  return cacheTTLMode === "off" ? null : cacheTTLMode;
}

function agentSections(agent: Agent | null): { title: string; text: string }[] {
  if (!agent) return [];
  return [
    { title: "Profile", text: agent.profile.trim() },
    { title: "Memory", text: agent.memory.trim() },
    { title: "Instructions", text: agent.instructions.trim() },
    { title: "World Book", text: agent.worldBook.trim() },
  ].filter((section) => section.text);
}

function estimateTokens(text: string): number {
  const cjkChars = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const nonCjkText = text.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, "");
  const nonCjkChars = nonCjkText.replace(/\s+/g, "").length;
  return Math.ceil(cjkChars + nonCjkChars / 4);
}

function agentFixedTokenEstimate(agent: Agent | null): number {
  return estimateTokens(
    agentSections(agent)
      .map((section) => `# ${section.title}\n${section.text}`)
      .join("\n\n"),
  );
}

function claudeCacheMinimumTokens(model: string | null): number | null {
  if (!model) return null;
  const id = model.toLowerCase().replace(/\./g, "-");
  if (
    id.includes("opus-4-7") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4-5") ||
    id.includes("haiku-4-5")
  ) {
    return 4096;
  }
  if (id.includes("sonnet-4-6") || id.includes("haiku-3-5")) {
    return 2048;
  }
  if (
    id.includes("sonnet-4-5") ||
    id.includes("sonnet-4") ||
    id.includes("opus-4-1") ||
    id.includes("opus-4") ||
    id.includes("sonnet-3-7")
  ) {
    return 1024;
  }
  return 1024;
}

function agentSystemContent(
  agent: Agent | null,
  agentPromptCache: ClaudePromptCacheTTL,
  cacheEnabled: boolean,
): ChatTextContentPart[] | undefined {
  const sections = agentSections(agent);

  if (sections.length === 0) return undefined;

  return sections.map((section, index) => {
    const part: ChatTextContentPart = {
      type: "text",
      text: `# ${section.title}\n${section.text}`,
    };
    if (
      cacheEnabled &&
      agentPromptCache !== "off" &&
      index === sections.length - 1
    ) {
      const ttl = promptCacheTTL(agentPromptCache);
      part.cache_control = {
        type: "ephemeral",
        ...(ttl === "1h" ? { ttl } : {}),
      };
    }
    return part;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgent(value: unknown): value is Agent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.profile === "string" &&
    typeof value.memory === "string" &&
    (value.instructions === undefined || typeof value.instructions === "string") &&
    (value.worldBook === undefined || typeof value.worldBook === "string") &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isVoiceAudioRef(value: unknown): value is CedarSyncBlobRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.mime === "string" &&
    typeof value.size === "number" &&
    (value.createdAt === undefined || typeof value.createdAt === "string")
  );
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value)) return false;
  if (
    (value.type === "text" || value.type === "thinking") &&
    typeof value.text === "string"
  ) {
    return true;
  }
  if (value.type === "voice") {
    return (
      typeof value.id === "string" &&
      typeof value.text === "string" &&
      (value.audioUrl === undefined || typeof value.audioUrl === "string") &&
      (value.audioRef === undefined || isVoiceAudioRef(value.audioRef)) &&
      (value.status === undefined ||
        value.status === "pending" ||
        value.status === "ready" ||
        value.status === "error") &&
      (value.error === undefined || typeof value.error === "string")
    );
  }
  if (value.type === "tool") {
    return (
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      (value.status === "pending" ||
        value.status === "success" ||
        value.status === "error") &&
      (value.input === undefined || typeof value.input === "string") &&
      (value.output === undefined || typeof value.output === "string") &&
      (value.error === undefined || typeof value.error === "string")
    );
  }
  return value.type === "attachment" && isChatAttachment(value.attachment);
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.mediaType === "string" &&
    typeof value.size === "number" &&
    (value.kind === "image" ||
      value.kind === "text" ||
      value.kind === "code" ||
      value.kind === "notebook" ||
      value.kind === "pdf" ||
      value.kind === "other") &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.dataUrl === undefined || typeof value.dataUrl === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isMessageUsage(value: unknown): value is StoredMessage["usage"] {
  if (!isRecord(value)) return false;
  return (
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    (value.cachedInputTokens === undefined ||
      typeof value.cachedInputTokens === "number") &&
    (value.cacheWriteInputTokens === undefined ||
      typeof value.cacheWriteInputTokens === "number")
  );
}

function isStoredMessageAlternative(
  value: unknown,
): value is StoredMessageAlternative {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.model === undefined ||
      value.model === null ||
      typeof value.model === "string") &&
    Array.isArray(value.content) &&
    value.content.every(isContentBlock) &&
    (value.createdAt === undefined || typeof value.createdAt === "number") &&
    (value.usage === undefined || isMessageUsage(value.usage))
  );
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    (value.model === undefined ||
      value.model === null ||
      typeof value.model === "string") &&
    Array.isArray(value.content) &&
    value.content.every(isContentBlock) &&
    (value.createdAt === undefined || typeof value.createdAt === "number") &&
    (value.usage === undefined || isMessageUsage(value.usage)) &&
    (value.alternatives === undefined ||
      (Array.isArray(value.alternatives) &&
        value.alternatives.every(isStoredMessageAlternative))) &&
    (value.activeAlternativeIndex === undefined ||
      typeof value.activeAlternativeIndex === "number")
  );
}

function isConversation(value: unknown): value is Conversation {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    (value.agentId === undefined ||
      value.agentId === null ||
      typeof value.agentId === "string") &&
    (value.providerId === undefined ||
      value.providerId === null ||
      typeof value.providerId === "string") &&
    (value.model === undefined ||
      value.model === null ||
      typeof value.model === "string") &&
    (value.temperature === undefined || typeof value.temperature === "number") &&
    (value.reasoningEnabled === undefined ||
      typeof value.reasoningEnabled === "boolean") &&
    (value.thinkingMode === undefined ||
      typeof value.thinkingMode === "string") &&
    (value.thinkingEffort === undefined ||
      typeof value.thinkingEffort === "string") &&
    (value.thinkingBudgetTokens === undefined ||
      typeof value.thinkingBudgetTokens === "number") &&
    (value.agentPromptCache === undefined ||
      typeof value.agentPromptCache === "string") &&
    (value.contextPromptCache === undefined ||
      typeof value.contextPromptCache === "string") &&
    (value.claudePromptCache === undefined ||
      typeof value.claudePromptCache === "string") &&
    (value.summaryProviderId === undefined ||
      value.summaryProviderId === null ||
      typeof value.summaryProviderId === "string") &&
    (value.summaryModel === undefined ||
      value.summaryModel === null ||
      typeof value.summaryModel === "string") &&
    (value.showMessageTimestamps === undefined ||
      typeof value.showMessageTimestamps === "boolean") &&
    (value.injectCurrentTime === undefined ||
      typeof value.injectCurrentTime === "boolean") &&
    (value.multiMessageEnabled === undefined ||
      typeof value.multiMessageEnabled === "boolean") &&
    (value.voiceMessagesEnabled === undefined ||
      typeof value.voiceMessagesEnabled === "boolean") &&
    (value.voiceMessageBudgetTokens === undefined ||
      typeof value.voiceMessageBudgetTokens === "number") &&
    typeof value.title === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    Array.isArray(value.messages) &&
    value.messages.every(isStoredMessage)
  );
}

function agentsFromImport(value: unknown): Agent[] {
  if (isRecord(value) && Array.isArray(value.agents)) {
    return value.agents.filter(isAgent).map(normalizeAgent);
  }
  return [];
}

function conversationsFromImport(value: unknown): Conversation[] {
  if (Array.isArray(value)) {
    return value.filter(isConversation);
  }
  if (isRecord(value) && Array.isArray(value.conversations)) {
    return value.conversations.filter(isConversation);
  }
  return [];
}

function providersFromSync(value: unknown): ProviderConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ProviderConfig => {
    if (!isRecord(item)) return false;
    return (
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      (item.kind === "openai-compatible" || item.kind === "anthropic") &&
      typeof item.baseUrl === "string" &&
      typeof item.apiKey === "string" &&
      Array.isArray(item.models) &&
      item.models.every((model) => typeof model === "string")
    );
  });
}

function mcpServersFromSync(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is McpServerConfig => {
    if (!isRecord(item)) return false;
    return (
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.url === "string" &&
      typeof item.bearerToken === "string" &&
      typeof item.enabled === "boolean"
    );
  });
}

function preferencesFromSync(value: unknown): Preferences {
  if (!isRecord(value)) {
    return {
      historyDepth: "all",
      chatFontSize: 18,
      chatDisplayMode: "cedar",
      thinkingSummaryEnabled: false,
      thinkingSummaryProviderId: null,
      thinkingSummaryModel: null,
    };
  }
  const historyDepth =
    value.historyDepth === "all"
      ? "all"
      : typeof value.historyDepth === "number" && Number.isFinite(value.historyDepth)
        ? Math.max(0, Math.min(300, Math.round(value.historyDepth)))
        : "all";
  const chatDisplayMode =
    value.chatDisplayMode === "wechat"
      ? "wechat"
      : value.chatDisplayMode === "claudeai"
        ? "claudeai"
        : "cedar";
  return {
    historyDepth,
    chatFontSize: normalizeChatFontSize(value.chatFontSize),
    chatDisplayMode,
    thinkingSummaryEnabled:
      typeof value.thinkingSummaryEnabled === "boolean"
        ? value.thinkingSummaryEnabled
        : false,
    thinkingSummaryProviderId:
      typeof value.thinkingSummaryProviderId === "string"
        ? value.thinkingSummaryProviderId
        : null,
    thinkingSummaryModel:
      typeof value.thinkingSummaryModel === "string"
        ? value.thinkingSummaryModel
        : null,
  };
}

function ttsSettingsFromSync(value: unknown): TtsSettings | null {
  if (!isRecord(value)) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (
    value.activeProfileId !== null &&
    value.activeProfileId !== undefined &&
    typeof value.activeProfileId !== "string"
  ) {
    return null;
  }
  if (!Array.isArray(value.profiles)) return null;
  return value as unknown as TtsSettings;
}

function currentFromSync(value: unknown): CurrentSelection {
  if (!isRecord(value)) return { providerId: null, model: null };
  return {
    providerId: typeof value.providerId === "string" ? value.providerId : null,
    model: typeof value.model === "string" ? value.model : null,
  };
}

function snapshotTime(snapshot: CedarSyncSnapshot): number {
  const time = Date.parse(snapshot.exportedAt);
  return Number.isFinite(time) ? time : 0;
}

function newestSnapshot<T>(
  localSnapshot: CedarSyncSnapshot,
  cloudSnapshot: CedarSyncSnapshot,
  localValue: T,
  cloudValue: T,
): T {
  return snapshotTime(localSnapshot) >= snapshotTime(cloudSnapshot)
    ? localValue
    : cloudValue;
}

function mergeByIdNewest<T extends { id: string; updatedAt?: number }>(
  localItems: T[],
  cloudItems: T[],
): T[] {
  const merged = new Map<string, T>();
  for (const item of cloudItems) merged.set(item.id, item);
  for (const item of localItems) {
    const existing = merged.get(item.id);
    if (!existing || (item.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      merged.set(item.id, item);
    }
  }
  return [...merged.values()].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
}

function mergeByIdSnapshotNewest<T extends { id: string }>(
  localSnapshot: CedarSyncSnapshot,
  cloudSnapshot: CedarSyncSnapshot,
  localItems: T[],
  cloudItems: T[],
): T[] {
  const preferLocal = snapshotTime(localSnapshot) >= snapshotTime(cloudSnapshot);
  const merged = new Map<string, T>();
  for (const item of preferLocal ? cloudItems : localItems) {
    merged.set(item.id, item);
  }
  for (const item of preferLocal ? localItems : cloudItems) {
    merged.set(item.id, item);
  }
  return [...merged.values()];
}

function mergeMessages(
  localMessages: StoredMessage[],
  cloudMessages: StoredMessage[],
  preferLocal: boolean,
): StoredMessage[] {
  const merged = new Map<string, StoredMessage>();
  const lowerPriority = preferLocal ? cloudMessages : localMessages;
  const higherPriority = preferLocal ? localMessages : cloudMessages;
  for (const message of lowerPriority) {
    merged.set(message.id, message);
  }
  for (const message of higherPriority) {
    const existing = merged.get(message.id);
    merged.set(
      message.id,
      existing ? pickMergedMessage(message, existing) : message,
    );
  }
  return [...merged.values()].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
}

function pickMergedMessage(
  preferred: StoredMessage,
  fallback: StoredMessage,
): StoredMessage {
  if (preferred.role !== "assistant" || fallback.role !== "assistant") {
    return preferred;
  }
  if (preferred.usage && !fallback.usage) return preferred;
  if (!preferred.usage && fallback.usage) return fallback;

  const preferredWeight = messageContentWeight(preferred);
  const fallbackWeight = messageContentWeight(fallback);
  return fallbackWeight > preferredWeight ? fallback : preferred;
}

function messageContentWeight(message: StoredMessage): number {
  return (
    contentBlocksToPlainText(message.content, true).length +
    message.content.length * 100 +
    (message.usage ? 10_000 : 0)
  );
}

interface ProtectedStreamMessageEntry {
  conversationId: string;
  message: StoredMessage;
  previousMessageId: string | null;
  conversationUpdatedAt: number;
  savedAt: number;
}

interface ProtectedStreamMessagesPayload {
  app: "cedar-chat-protected-stream-messages";
  version: 1;
  entries: ProtectedStreamMessageEntry[];
}

function isProtectedStreamMessageEntry(
  value: unknown,
): value is ProtectedStreamMessageEntry {
  if (!isRecord(value)) return false;
  const message = value.message;
  return (
    typeof value.conversationId === "string" &&
    typeof value.savedAt === "number" &&
    typeof value.conversationUpdatedAt === "number" &&
    (value.previousMessageId === null || typeof value.previousMessageId === "string") &&
    isRecord(message) &&
    typeof message.id === "string" &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

function loadProtectedStreamMessages(): ProtectedStreamMessageEntry[] {
  try {
    const raw = localStorage.getItem(PROTECTED_STREAM_MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.app !== "cedar-chat-protected-stream-messages") {
      return [];
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];

    const cutoff = Date.now() - PROTECTED_STREAM_MESSAGES_TTL_MS;
    return parsed.entries
      .filter(isProtectedStreamMessageEntry)
      .filter((entry) => entry.savedAt >= cutoff)
      .slice(0, MAX_PROTECTED_STREAM_MESSAGES);
  } catch {
    return [];
  }
}

function saveProtectedStreamMessageEntries(
  entries: ProtectedStreamMessageEntry[],
) {
  const cutoff = Date.now() - PROTECTED_STREAM_MESSAGES_TTL_MS;
  const payload: ProtectedStreamMessagesPayload = {
    app: "cedar-chat-protected-stream-messages",
    version: 1,
    entries: entries
      .filter((entry) => entry.savedAt >= cutoff)
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(0, MAX_PROTECTED_STREAM_MESSAGES),
  };

  try {
    localStorage.setItem(PROTECTED_STREAM_MESSAGES_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("Could not save protected stream messages.", error);
  }
}

function saveProtectedStreamMessages(conversations: Conversation[]) {
  const now = Date.now();
  const nextEntries = new Map<string, ProtectedStreamMessageEntry>();

  for (const entry of loadProtectedStreamMessages()) {
    nextEntries.set(`${entry.conversationId}:${entry.message.id}`, entry);
  }

  const protectedConversations = conversations
    .filter((conversation) => conversation.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 4);

  for (const conversation of protectedConversations) {
    const recentAssistantMessages = conversation.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === "assistant")
      .slice(-6);

    for (const { message, index } of recentAssistantMessages) {
      if (messageContentWeight(message) === 0) continue;
      const previousMessage = conversation.messages[index - 1];
      nextEntries.set(`${conversation.id}:${message.id}`, {
        conversationId: conversation.id,
        message: stripTransient(message as UIMessage),
        previousMessageId: previousMessage?.id ?? null,
        conversationUpdatedAt: conversation.updatedAt,
        savedAt: now,
      });
    }
  }

  saveProtectedStreamMessageEntries([...nextEntries.values()]);
}

function mergeProtectedStreamMessages(conversations: Conversation[]): Conversation[] {
  const protectedEntries = loadProtectedStreamMessages();
  if (protectedEntries.length === 0) return conversations;

  let changed = false;
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );

  for (const entry of protectedEntries) {
    const conversation = conversationsById.get(entry.conversationId);
    if (!conversation) continue;

    const existingIndex = conversation.messages.findIndex(
      (message) => message.id === entry.message.id,
    );

    if (existingIndex === -1) {
      const previousIndex = entry.previousMessageId
        ? conversation.messages.findIndex(
            (message) => message.id === entry.previousMessageId,
          )
        : -1;
      const insertIndex =
        previousIndex >= 0 ? previousIndex + 1 : conversation.messages.length;
      const nextMessages = [...conversation.messages];
      nextMessages.splice(insertIndex, 0, entry.message);
      conversationsById.set(entry.conversationId, {
        ...conversation,
        messages: nextMessages,
        updatedAt: Math.max(conversation.updatedAt, entry.conversationUpdatedAt),
      });
      changed = true;
      continue;
    }

    const existing = conversation.messages[existingIndex];
    const protectedMessage = pickMergedMessage(entry.message, existing);
    if (protectedMessage !== existing) {
      const nextMessages = [...conversation.messages];
      nextMessages[existingIndex] = protectedMessage;
      conversationsById.set(entry.conversationId, {
        ...conversation,
        messages: nextMessages,
        updatedAt: Math.max(conversation.updatedAt, entry.conversationUpdatedAt),
      });
      changed = true;
    }
  }

  if (!changed) return conversations;
  return conversations.map(
    (conversation) => conversationsById.get(conversation.id) ?? conversation,
  );
}

function mergeConversations(
  localConversations: Conversation[],
  cloudConversations: Conversation[],
): Conversation[] {
  const merged = new Map<string, Conversation>();
  for (const conversation of cloudConversations) {
    merged.set(conversation.id, conversation);
  }
  for (const conversation of localConversations) {
    const existing = merged.get(conversation.id);
    if (!existing) {
      merged.set(conversation.id, conversation);
      continue;
    }

    const preferLocal = conversation.updatedAt >= existing.updatedAt;
    const base = preferLocal ? conversation : existing;
    const other = preferLocal ? existing : conversation;
    merged.set(conversation.id, {
      ...base,
      createdAt: Math.min(base.createdAt, other.createdAt),
      updatedAt: Math.max(base.updatedAt, other.updatedAt),
      messages: mergeMessages(conversation.messages, existing.messages, preferLocal),
    });
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function mergeTtsSettings(
  localSnapshot: CedarSyncSnapshot,
  cloudSnapshot: CedarSyncSnapshot,
): TtsSettings {
  const local = ttsSettingsFromSync(localSnapshot.ttsSettings);
  const cloud = ttsSettingsFromSync(cloudSnapshot.ttsSettings);
  if (!local && !cloud) return { enabled: false, activeProfileId: null, profiles: [] };
  if (!local) return cloud!;
  if (!cloud) return local;

  const profiles = mergeByIdSnapshotNewest(
    localSnapshot,
    cloudSnapshot,
    local.profiles,
    cloud.profiles,
  );
  const newest = newestSnapshot(localSnapshot, cloudSnapshot, local, cloud);
  return {
    enabled: newest.enabled,
    activeProfileId: profiles.some((profile) => profile.id === newest.activeProfileId)
      ? newest.activeProfileId
      : (profiles[0]?.id ?? null),
    profiles,
  };
}

function mergeSyncSnapshots(
  localSnapshot: CedarSyncSnapshot,
  cloudSnapshot: CedarSyncSnapshot,
): CedarSyncSnapshot {
  const agents = mergeByIdNewest(
    agentsFromImport(localSnapshot),
    agentsFromImport(cloudSnapshot),
  );
  const fallbackAgentId =
    localSnapshot.activeAgentId ??
    cloudSnapshot.activeAgentId ??
    agents[0]?.id ??
    null;
  const conversations = mergeConversations(
    conversationsFromImport(localSnapshot),
    conversationsFromImport(cloudSnapshot),
  );
  const activeAgentId = agents.some((agent) => agent.id === localSnapshot.activeAgentId)
    ? localSnapshot.activeAgentId
    : agents.some((agent) => agent.id === cloudSnapshot.activeAgentId)
      ? cloudSnapshot.activeAgentId
      : fallbackAgentId;
  const activeConversationId = conversations.some(
    (conversation) => conversation.id === localSnapshot.activeConversationId,
  )
    ? localSnapshot.activeConversationId
    : conversations.some(
          (conversation) => conversation.id === cloudSnapshot.activeConversationId,
        )
      ? cloudSnapshot.activeConversationId
      : (conversations[0]?.id ?? null);

  return {
    app: "cedar-chat",
    version: 1,
    exportedAt: new Date().toISOString(),
    ...(localSnapshot.deviceName ? { deviceName: localSnapshot.deviceName } : {}),
    current: newestSnapshot(
      localSnapshot,
      cloudSnapshot,
      currentFromSync(localSnapshot.current),
      currentFromSync(cloudSnapshot.current),
    ),
    preferences: newestSnapshot(
      localSnapshot,
      cloudSnapshot,
      preferencesFromSync(localSnapshot.preferences),
      preferencesFromSync(cloudSnapshot.preferences),
    ),
    providers: mergeByIdSnapshotNewest(
      localSnapshot,
      cloudSnapshot,
      providersFromSync(localSnapshot.providers),
      providersFromSync(cloudSnapshot.providers),
    ),
    mcpServers: mergeByIdSnapshotNewest(
      localSnapshot,
      cloudSnapshot,
      mcpServersFromSync(localSnapshot.mcpServers),
      mcpServersFromSync(cloudSnapshot.mcpServers),
    ),
    ttsSettings: mergeTtsSettings(localSnapshot, cloudSnapshot),
    agents,
    activeAgentId,
    conversations,
    activeConversationId,
  };
}

function normalizeConversationsForAgents(
  conversations: Conversation[],
  agents: Agent[],
  fallbackAgentId: string | null,
  fallbackCacheMode: ClaudePromptCacheMode,
): Conversation[] {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const fallbackCurrent = loadCurrent();
  return conversations.map((conversation) => ({
    ...conversation,
    agentId:
      conversation.agentId && agentIds.has(conversation.agentId)
        ? conversation.agentId
        : fallbackAgentId,
    providerId:
      typeof conversation.providerId === "string"
        ? conversation.providerId
        : fallbackCurrent.providerId,
    model:
      typeof conversation.model === "string"
        ? conversation.model
        : fallbackCurrent.model,
    temperature: normalizeTemperature(conversation.temperature),
    reasoningEnabled:
      typeof conversation.reasoningEnabled === "boolean"
        ? conversation.reasoningEnabled
        : DEFAULT_REASONING_ENABLED,
    thinkingMode: normalizeThinkingMode(conversation.thinkingMode),
    thinkingEffort: normalizeThinkingEffort(conversation.thinkingEffort),
    thinkingBudgetTokens: normalizeThinkingBudgetTokens(
      conversation.thinkingBudgetTokens,
    ),
    agentPromptCache: normalizeClaudePromptCacheTTL(
      conversation.agentPromptCache,
      splitLegacyPromptCacheMode(
        conversation.claudePromptCache ?? fallbackCacheMode,
      ).agentPromptCache,
    ),
    contextPromptCache: normalizeClaudePromptCacheTTL(
      conversation.contextPromptCache,
      splitLegacyPromptCacheMode(
        conversation.claudePromptCache ?? fallbackCacheMode,
      ).contextPromptCache,
    ),
    summaryProviderId:
      typeof conversation.summaryProviderId === "string"
        ? conversation.summaryProviderId
        : null,
    summaryModel:
      typeof conversation.summaryModel === "string"
        ? conversation.summaryModel
        : null,
    showMessageTimestamps: conversation.showMessageTimestamps ?? false,
    injectCurrentTime: conversation.injectCurrentTime ?? false,
    multiMessageEnabled:
      conversation.multiMessageEnabled ?? DEFAULT_MULTI_MESSAGE_ENABLED,
    voiceMessagesEnabled:
      conversation.voiceMessagesEnabled ?? DEFAULT_VOICE_MESSAGES_ENABLED,
    voiceMessageBudgetTokens: normalizeVoiceMessageBudgetTokens(
      conversation.voiceMessageBudgetTokens,
    ),
    messages: conversation.messages.map(stripTransient),
  }));
}

function loadInitialChatState(): {
  agents: Agent[];
  activeAgentId: string | null;
  conversations: Conversation[];
  activeConversationId: string | null;
} {
  const savedAgents = loadAgents().filter(isAgent).map(normalizeAgent);
  const agents = savedAgents.length > 0 ? savedAgents : [createDefaultAgent()];
  const fallbackCacheMode = legacyGlobalCacheMode();
  const savedActiveAgentId = loadActiveAgentId();
  const activeAgentId = agents.some((a) => a.id === savedActiveAgentId)
    ? savedActiveAgentId
    : (agents[0]?.id ?? null);

  const saved = loadConversations();
  const conversations = mergeProtectedStreamMessages(
    saved.length > 0
      ? normalizeConversationsForAgents(
          saved,
          agents,
          activeAgentId,
          fallbackCacheMode,
        )
      : [createEmptyConversation(activeAgentId)],
  );
  const activeId = loadActiveConversationId();
  const firstForAgent =
    conversations.find((conversation) => conversation.agentId === activeAgentId)
      ?.id ?? conversations[0]?.id ?? null;

  return {
    agents,
    activeAgentId,
    conversations,
    activeConversationId: conversations.some((c) => c.id === activeId)
      ? activeId
      : firstForAgent,
  };
}

type ChatState = ReturnType<typeof loadInitialChatState>;

function hasPersistedMessages(conversations: Conversation[]): boolean {
  return conversations.some((conversation) => conversation.messages.length > 0);
}

function backupHasNewerConversationData(
  backupConversations: Conversation[],
  currentConversations: Conversation[],
): boolean {
  const currentById = new Map(
    currentConversations.map((conversation) => [conversation.id, conversation]),
  );

  for (const backupConversation of backupConversations) {
    if (backupConversation.messages.length === 0) continue;

    const currentConversation = currentById.get(backupConversation.id);
    if (!currentConversation) return true;
    if (backupConversation.updatedAt > currentConversation.updatedAt) return true;
    if (backupConversation.messages.length > currentConversation.messages.length) {
      return true;
    }

    const currentMessagesById = new Map(
      currentConversation.messages.map((message) => [message.id, message]),
    );
    for (const backupMessage of backupConversation.messages) {
      const currentMessage = currentMessagesById.get(backupMessage.id);
      if (!currentMessage) return true;
      if (messageContentWeight(backupMessage) > messageContentWeight(currentMessage)) {
        return true;
      }
    }
  }

  return false;
}

function chatStateFromLocalBackup(backup: CedarLocalBackup): {
  agents: Agent[];
  activeAgentId: string | null;
  conversations: Conversation[];
  activeConversationId: string | null;
} {
  const agents = backup.agents.length > 0 ? backup.agents : [createDefaultAgent()];
  const activeAgentId =
    backup.activeAgentId && agents.some((agent) => agent.id === backup.activeAgentId)
      ? backup.activeAgentId
      : (agents[0]?.id ?? null);
  const conversations = mergeProtectedStreamMessages(
    backup.conversations.length > 0
      ? backup.conversations
      : [createEmptyConversation(activeAgentId)],
  );
  const activeConversationId =
    backup.activeConversationId &&
    conversations.some(
      (conversation) => conversation.id === backup.activeConversationId,
    )
      ? backup.activeConversationId
      : (conversations[0]?.id ?? null);

  return {
    agents,
    activeAgentId,
    conversations,
    activeConversationId,
  };
}

function localSyncVersion(
  providers: ProviderConfig[],
  current: CurrentSelection,
  preferences: Preferences,
  mcpServers: McpServerConfig[],
  ttsSettings: TtsSettings,
  agents: Agent[],
  activeAgentId: string | null,
  conversations: Conversation[],
  activeConversationId: string | null,
  userStyleSettings: UserStyleSettings,
): string {
  return JSON.stringify({
    providers,
    current,
    preferences,
    mcpServers,
    ttsSettings,
    agents: agents.map((agent) => ({
      id: agent.id,
      updatedAt: agent.updatedAt,
    })),
    activeAgentId,
    conversations: conversations.map((conversation) => {
      const lastMessage = conversation.messages.at(-1);
      return {
        id: conversation.id,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length,
        lastMessageId: lastMessage?.id ?? null,
        lastMessageWeight: lastMessage ? messageContentWeight(lastMessage) : 0,
      };
    }),
    activeConversationId,
    userStyleSettings,
  });
}

// ------------------------- App -------------------------

export default function App() {
  // --- Provider config state ---
  const [providers, setProviders] = useState<ProviderConfig[]>(() =>
    loadProviders(),
  );
  const [currentProviderId, setCurrentProviderId] = useState<string | null>(
    () => loadCurrent().providerId,
  );
  const [currentModel, setCurrentModel] = useState<string | null>(
    () => loadCurrent().model,
  );
  const [preferences, setPreferences] = useState<Preferences>(() =>
    loadPreferences(),
  );
  const [ttsSettings, setTtsSettings] = useState<TtsSettings>(() =>
    loadTtsSettings(),
  );
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(() =>
    loadSyncSettings(),
  );
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() =>
    loadMcpServers(),
  );
  const [userStyleSettings, setUserStyleSettings] = useState<UserStyleSettings>(
    () => loadUserStyleSettings(),
  );
  const userStyle = useMemo(
    () => getActiveUserStyle(userStyleSettings)?.prompt ?? "",
    [userStyleSettings],
  );
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("providers");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [chatState, setChatStateRaw] = useState<ChatState>(loadInitialChatState);
  const agents = chatState.agents;
  const activeAgentId = chatState.activeAgentId;
  const conversations = chatState.conversations;
  const activeConversationId = chatState.activeConversationId;
  const latestConversationsRef = useRef(conversations);

  function setChatState(next: ChatState | ((previous: ChatState) => ChatState)) {
    setChatStateRaw((previous) => {
      const nextState = typeof next === "function" ? next(previous) : next;
      latestConversationsRef.current = nextState.conversations;
      return nextState;
    });
  }

  function handleUserStyleSettingsChange(next: UserStyleSettings) {
    setUserStyleSettings(next);
    saveUserStyleSettings(next);
  }

  function setConversations(
    next:
      | Conversation[]
      | ((previousConversations: Conversation[]) => Conversation[]),
  ) {
    setChatState((previous) => {
      const nextConversations =
        typeof next === "function" ? next(previous.conversations) : next;
      latestConversationsRef.current = nextConversations;
      if (streamingLockRef.current) {
        scheduleStreamingDurableSave(nextConversations);
      }
      return {
        ...previous,
        conversations: nextConversations,
      };
    });
  }

  function setActiveConversationId(id: string | null) {
    setChatState((previous) => ({ ...previous, activeConversationId: id }));
  }

  function selectAgent(agentId: string) {
    setChatState((previous) => {
      const existing = previous.conversations.find(
        (conversation) => conversation.agentId === agentId,
      );
      if (existing) {
        return {
          ...previous,
          activeAgentId: agentId,
          activeConversationId: existing.id,
        };
      }

      const conversation = createEmptyConversation(agentId);
      return {
        ...previous,
        conversations: [conversation, ...previous.conversations],
        activeAgentId: agentId,
        activeConversationId: conversation.id,
      };
    });
    setSidebarOpen(false);
    cancelEditing();
  }

  function selectConversation(conversationId: string, messageId?: string) {
    const target = conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    setChatState((previous) => ({
      ...previous,
      activeAgentId: target?.agentId ?? previous.activeAgentId,
      activeConversationId: conversationId,
    }));
    if (messageId) setPendingSearchMessageId(messageId);
    setSidebarOpen(false);
    cancelEditing();
  }

  function openSettings(tab: SettingsTab = "providers") {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  // --- Chat state ---
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? agents[0] ?? null,
    [activeAgentId, agents],
  );
  const agentConversations = useMemo(
    () =>
      activeAgent
        ? conversations.filter(
            (conversation) => conversation.agentId === activeAgent.id,
          )
        : conversations,
    [activeAgent, conversations],
  );
  const activeConversation = useMemo(
    () =>
      agentConversations.find((c) => c.id === activeConversationId) ??
      agentConversations[0] ??
      null,
    [activeConversationId, agentConversations],
  );
  const activeConversationAgent = useMemo(
    () =>
      agents.find((agent) => agent.id === activeConversation?.agentId) ??
      activeAgent,
    [activeAgent, activeConversation?.agentId, agents],
  );
  const messages = useMemo<UIMessage[]>(
    () => activeConversation?.messages ?? [],
    [activeConversation],
  );

  // ─── Thinking 自动总结副作用 ──────────────────────────────────────
  // 监听消息列表,对每条"已完成 + 含 thinking 块 + summary 还没跑"的 assistant
  // 消息,起一个超短上下文的异步总结。完全旁路,不阻塞主回复;失败只在 UI 标记。
  // 已总结过的(summaryStatus = "done"/"pending"/"error")永远不重跑。
  const pendingThinkingSummariesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!preferences.thinkingSummaryEnabled) return;
    const providerId = preferences.thinkingSummaryProviderId;
    const model = preferences.thinkingSummaryModel;
    if (!providerId || !model) return;
    const summaryProvider = providers.find((p) => p.id === providerId);
    if (!summaryProvider) return;
    if (!activeConversation) return;

    const conversationId = activeConversation.id;

    // 收集需要总结的目标(messageId + blockIndex + text)
    type Target = { messageId: string; blockIndex: number; text: string };
    const targets: Target[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (message.streaming) continue;
      for (let i = 0; i < message.content.length; i += 1) {
        const block = message.content[i];
        if (block.type !== "thinking") continue;
        if (block.summaryStatus) continue; // pending/done/error 都跳过
        if (!block.text || !block.text.trim()) continue;
        const dedupeKey = `${message.id}#${i}`;
        if (pendingThinkingSummariesRef.current.has(dedupeKey)) continue;
        targets.push({ messageId: message.id, blockIndex: i, text: block.text });
      }
    }

    if (targets.length === 0) return;

    // 先把状态改成 pending,避免下一次 effect 重复触发
    setConversations((previous) =>
      previous.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        let touched = false;
        const nextMessages = conversation.messages.map((message) => {
          const matches = targets.filter((t) => t.messageId === message.id);
          if (matches.length === 0) return message;
          const nextContent = message.content.map((block, idx) => {
            const hit = matches.find((m) => m.blockIndex === idx);
            if (!hit || block.type !== "thinking") return block;
            touched = true;
            return { ...block, summaryStatus: "pending" as const };
          });
          return { ...message, content: nextContent };
        });
        return touched ? { ...conversation, messages: nextMessages } : conversation;
      }),
    );

    for (const target of targets) {
      const dedupeKey = `${target.messageId}#${target.blockIndex}`;
      pendingThinkingSummariesRef.current.add(dedupeKey);

      summarizeThinking({
        provider: summaryProvider,
        model,
        thinkingText: target.text,
      })
        .then((summary) => {
          setConversations((previous) =>
            previous.map((conversation) => {
              if (conversation.id !== conversationId) return conversation;
              const nextMessages = conversation.messages.map((message) => {
                if (message.id !== target.messageId) return message;
                const nextContent = message.content.map((block, idx) => {
                  if (idx !== target.blockIndex || block.type !== "thinking") return block;
                  return {
                    ...block,
                    summary,
                    summaryStatus: "done" as const,
                    summaryError: undefined,
                  };
                });
                return { ...message, content: nextContent };
              });
              return { ...conversation, messages: nextMessages };
            }),
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setConversations((previous) =>
            previous.map((conversation) => {
              if (conversation.id !== conversationId) return conversation;
              const nextMessages = conversation.messages.map((m) => {
                if (m.id !== target.messageId) return m;
                const nextContent = m.content.map((block, idx) => {
                  if (idx !== target.blockIndex || block.type !== "thinking") return block;
                  return {
                    ...block,
                    summaryStatus: "error" as const,
                    summaryError: message,
                  };
                });
                return { ...m, content: nextContent };
              });
              return { ...conversation, messages: nextMessages };
            }),
          );
        })
        .finally(() => {
          pendingThinkingSummariesRef.current.delete(dedupeKey);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messages,
    activeConversation?.id,
    preferences.thinkingSummaryEnabled,
    preferences.thinkingSummaryProviderId,
    preferences.thinkingSummaryModel,
    providers,
  ]);
  const activeTtsProfile = useMemo(
    () => getActiveTtsProfile(ttsSettings),
    [ttsSettings],
  );
  const ttsVoiceMessagesAvailable =
    ttsSettings.enabled && canSynthesizeSpeechWithProfile(activeTtsProfile);
  const activeAgentPromptCache =
    activeConversation?.agentPromptCache ?? DEFAULT_AGENT_PROMPT_CACHE;
  const activeContextPromptCache =
    activeConversation?.contextPromptCache ?? DEFAULT_CONTEXT_PROMPT_CACHE;
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [dragDepth, setDragDepth] = useState(0);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSelectedIds, setExportSelectedIds] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState("");
  const [conversationSearchScope, setConversationSearchScope] =
    useState<SidebarSearchScope>("agent");
  const [pendingSearchMessageId, setPendingSearchMessageId] = useState<
    string | null
  >(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [pinSummaryError, setPinSummaryError] = useState<{
    conversationId: string;
    messageId: string;
    message: string;
  } | null>(null);
  const [beijingTime, setBeijingTime] = useState(() => formatBeijingClock());
  const [weatherLabel, setWeatherLabel] = useState(WEATHER_FALLBACK_LABEL);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [windowSettingsOpen, setWindowSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [localBackupReady, setLocalBackupReady] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [autoPlayVoiceBlockIds, setAutoPlayVoiceBlockIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const abortRef = useRef<AbortController | null>(null);
  const streamingLockRef = useRef(false);
  const streamingSaveTimerRef = useRef<number | null>(null);
  const pendingStreamingSaveRef = useRef<Conversation[] | null>(null);
  const streamSyncCooldownUntilRef = useRef(0);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const requestedVoiceAutoplayRef = useRef<Set<string>>(new Set());
  const voiceAudioUrlsRef = useRef<Set<string>>(new Set());
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  // --- 派生值 ---
  const activeProviderId = activeConversation?.providerId ?? currentProviderId;
  const activeModel = activeConversation?.model ?? currentModel;
  const temperature = activeConversation?.temperature ?? DEFAULT_TEMPERATURE;
  const reasoningEnabled =
    activeConversation?.reasoningEnabled ?? DEFAULT_REASONING_ENABLED;
  const thinkingMode = activeConversation?.thinkingMode ?? DEFAULT_THINKING_MODE;
  const effort = activeConversation?.thinkingEffort ?? DEFAULT_THINKING_EFFORT;
  const budgetTokens =
    activeConversation?.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
  const multiMessageEnabled =
    activeConversation?.multiMessageEnabled ?? DEFAULT_MULTI_MESSAGE_ENABLED;
  const voiceMessagesEnabled =
    activeConversation?.voiceMessagesEnabled ?? DEFAULT_VOICE_MESSAGES_ENABLED;
  const voiceMessageBudgetTokens =
    activeConversation?.voiceMessageBudgetTokens ??
    DEFAULT_VOICE_MESSAGE_BUDGET_TOKENS;
  const trimmedConversationSearchQuery = conversationSearchQuery.trim();
  const sidebarSearchConversations =
    conversationSearchScope === "all" ? conversations : agentConversations;
  const conversationSearchResults = useMemo(
    () =>
      trimmedConversationSearchQuery
        ? searchConversations(
            sidebarSearchConversations,
            trimmedConversationSearchQuery,
            80,
          )
        : [],
    [sidebarSearchConversations, trimmedConversationSearchQuery],
  );
  const titleOnlySearchConversations = useMemo(() => {
    if (!trimmedConversationSearchQuery) return [];
    const messageMatchIds = new Set(
      conversationSearchResults.map((result) => result.conversationId),
    );
    return searchConversationTitles(
      sidebarSearchConversations,
      trimmedConversationSearchQuery,
    ).filter((conversation) => !messageMatchIds.has(conversation.id));
  }, [
    conversationSearchResults,
    sidebarSearchConversations,
    trimmedConversationSearchQuery,
  ]);
  const hasConversationSearchResults =
    conversationSearchResults.length > 0 || titleOnlySearchConversations.length > 0;

  const currentProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId) ?? null,
    [providers, activeProviderId],
  );

  const selectedModel = useMemo(
    () =>
      currentProvider && activeModel && currentProvider.models.includes(activeModel)
        ? activeModel
        : (currentProvider?.models[0] ?? null),
    [activeModel, currentProvider],
  );

  const summaryProviderId =
    activeConversation?.summaryProviderId ?? activeProviderId;
  const summaryProvider = useMemo(
    () => providers.find((p) => p.id === summaryProviderId) ?? null,
    [providers, summaryProviderId],
  );
  const activeSummaryModel = activeConversation?.summaryModel ?? null;
  const selectedSummaryModel =
    summaryProvider &&
    activeSummaryModel &&
    summaryProvider.models.includes(activeSummaryModel)
      ? activeSummaryModel
      : (summaryProvider?.models[0] ?? null);
  const activePinSummaryError =
    pinSummaryError?.conversationId === activeConversation?.id
      ? pinSummaryError
      : null;

  const capability = useMemo(
    () => (selectedModel ? getCapability(selectedModel) : null),
    [selectedModel],
  );
  const claudeCacheAvailable = isOpenRouterClaude(currentProvider, selectedModel);
  const agentCacheEstimate = useMemo(
    () => agentFixedTokenEstimate(activeConversationAgent),
    [activeConversationAgent],
  );
  const agentCacheMinimum = useMemo(
    () => claudeCacheMinimumTokens(selectedModel),
    [selectedModel],
  );
  const lastAssistantId = useMemo(
    () => messages.findLast((m) => m.role === "assistant")?.id ?? null,
    [messages],
  );
  const contextSections = useMemo(
    () => agentSections(activeConversationAgent),
    [activeConversationAgent],
  );
  const lastUsage = useMemo(
    () => messages.findLast((message) => message.usage)?.usage,
    [messages],
  );
  const conversationCostEstimate = useMemo(
    () => estimateConversationCost(messages, selectedModel),
    [messages, selectedModel],
  );
  const enabledMcpServers = useMemo(
    () => mcpServers.filter((server) => server.enabled),
    [mcpServers],
  );
  const canSend = Boolean(
    currentProvider &&
      selectedModel &&
      hasUserContent(input, pendingAttachments) &&
      !attaching,
  );
  const appStyle = useMemo(
    () =>
      ({
        "--cedar-chat-font-size": `${preferences.chatFontSize}px`,
      }) as CSSProperties,
    [preferences.chatFontSize],
  );
  const syncLocalVersion = useMemo(
    () =>
      localSyncVersion(
        providers,
        {
          providerId: activeProviderId ?? currentProviderId,
          model: selectedModel ?? currentModel,
        },
        preferences,
        mcpServers,
        ttsSettings,
        agents,
        activeAgent?.id ?? activeAgentId,
        conversations,
        activeConversation?.id ?? activeConversationId,
        userStyleSettings,
      ),
    [
      providers,
      activeProviderId,
      currentProviderId,
      selectedModel,
      currentModel,
      preferences,
      mcpServers,
      ttsSettings,
      agents,
      activeAgent,
      activeAgentId,
      conversations,
      activeConversation,
      activeConversationId,
      userStyleSettings,
    ],
  );

  function snapshotActiveConversationId(
    snapshotConversations: Conversation[],
  ): string | null {
    return activeConversationId &&
      snapshotConversations.some(
        (conversation) => conversation.id === activeConversationId,
      )
      ? activeConversationId
      : (snapshotConversations[0]?.id ?? null);
  }

  function createLocalBackupSnapshot(
    snapshotConversations = latestConversationsRef.current,
  ): CedarLocalBackup {
    return {
      app: "cedar-chat-local-backup",
      version: 1,
      savedAt: Date.now(),
      current: {
        providerId: activeProviderId ?? currentProviderId,
        model: selectedModel ?? currentModel,
      },
      preferences,
      providers,
      mcpServers,
      ttsSettings,
      syncSettings,
      userStyle,
      userStyleSettings,
      agents,
      activeAgentId: activeAgent?.id ?? activeAgentId,
      conversations: snapshotConversations.map(stripTransientConversation),
      activeConversationId: snapshotActiveConversationId(snapshotConversations),
    };
  }

  function setStreamingLock(active: boolean) {
    streamingLockRef.current = active;
    const browserWindow = window as Window & {
      __cedarChatStreamingLock?: boolean;
    };
    if (active) {
      browserWindow.__cedarChatStreamingLock = true;
    } else {
      delete browserWindow.__cedarChatStreamingLock;
    }
  }

  function streamProtectionActive(): boolean {
    return (
      abortRef.current !== null ||
      streamingLockRef.current ||
      Date.now() < streamSyncCooldownUntilRef.current
    );
  }

  function persistConversationSnapshotNow(
    snapshotConversations = latestConversationsRef.current,
  ) {
    saveConversations(snapshotConversations);
    if (streamingLockRef.current) {
      saveProtectedStreamMessages(snapshotConversations);
    }
    saveActiveConversationId(snapshotActiveConversationId(snapshotConversations));
    if (localBackupReady) {
      void saveLocalBackup(createLocalBackupSnapshot(snapshotConversations));
    }
  }

  function scheduleStreamingDurableSave(
    snapshotConversations = latestConversationsRef.current,
  ) {
    if (!streamingLockRef.current) return;
    pendingStreamingSaveRef.current = snapshotConversations;
    if (streamingSaveTimerRef.current !== null) return;

    streamingSaveTimerRef.current = window.setTimeout(() => {
      streamingSaveTimerRef.current = null;
      const pending =
        pendingStreamingSaveRef.current ?? latestConversationsRef.current;
      pendingStreamingSaveRef.current = null;
      persistConversationSnapshotNow(pending);
    }, STREAM_DURABLE_SAVE_INTERVAL_MS);
  }

  function flushStreamingDurableSave(snapshotConversations?: Conversation[]) {
    if (streamingSaveTimerRef.current !== null) {
      window.clearTimeout(streamingSaveTimerRef.current);
      streamingSaveTimerRef.current = null;
    }
    const pending =
      snapshotConversations ??
      pendingStreamingSaveRef.current ??
      latestConversationsRef.current;
    pendingStreamingSaveRef.current = null;
    persistConversationSnapshotNow(pending);
  }

  function releaseStreamingLockAfterSave() {
    window.setTimeout(() => {
      flushStreamingDurableSave();
      streamSyncCooldownUntilRef.current = Date.now() + STREAM_SYNC_COOLDOWN_MS;
      setStreamingLock(false);
    }, 0);
  }

  // --- 持久化副作用 ---
  useEffect(() => {
    latestConversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    let cancelled = false;

    async function restoreLocalBackup() {
      const backup = await loadLocalBackup();
      if (cancelled) return;

      if (backup && hasPersistedMessages(backup.conversations)) {
        const currentConversations = latestConversationsRef.current;
        const shouldRestore = !hasPersistedMessages(currentConversations);
        const shouldMerge =
          !shouldRestore &&
          backupHasNewerConversationData(
            backup.conversations,
            currentConversations,
          );

        if (shouldRestore) {
          const restoredState = chatStateFromLocalBackup(backup);
          latestConversationsRef.current = restoredState.conversations;
          setProviders(backup.providers);
          setCurrentProviderId(backup.current.providerId);
          setCurrentModel(backup.current.model);
          setPreferences(preferencesFromSync(backup.preferences));
          setMcpServers(backup.mcpServers);
          setTtsSettings(backup.ttsSettings);
          setSyncSettings(backup.syncSettings);
          setUserStyleSettings(backup.userStyleSettings);
          setChatState(restoredState);
          setSyncStatus("Restored local history from this browser.");
        } else if (shouldMerge) {
          const backupState = chatStateFromLocalBackup(backup);
          setChatState((previous) => {
            const mergedAgents = mergeByIdNewest(previous.agents, backupState.agents);
            const mergedConversations = mergeConversations(
              previous.conversations,
              backupState.conversations,
            );
            const protectedConversations =
              mergeProtectedStreamMessages(mergedConversations);
            latestConversationsRef.current = protectedConversations;
            return {
              ...previous,
              agents: mergedAgents.length > 0 ? mergedAgents : previous.agents,
              conversations: protectedConversations,
            };
          });
          setSyncStatus("Recovered newer local message history.");
        }
      }

      setLocalBackupReady(true);
    }

    void restoreLocalBackup();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!localBackupReady) return;
    const timer = window.setTimeout(() => {
      saveLocalBackupSoon(createLocalBackupSnapshot(conversations));
    }, CONVERSATION_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    localBackupReady,
    activeProviderId,
    currentProviderId,
    selectedModel,
    currentModel,
    preferences,
    providers,
    mcpServers,
    ttsSettings,
    syncSettings,
    userStyle,
    userStyleSettings,
    agents,
    activeAgent,
    activeAgentId,
    conversations,
    activeConversation,
    activeConversationId,
  ]);

  useEffect(() => {
    saveProviders(providers);
  }, [providers]);

  useEffect(() => {
    saveCurrent({ providerId: activeProviderId ?? null, model: selectedModel });
  }, [activeProviderId, selectedModel]);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    saveTtsSettings(ttsSettings);
  }, [ttsSettings]);

  useEffect(() => {
    saveSyncSettings(syncSettings);
  }, [syncSettings]);

  useEffect(() => {
    saveMcpServers(mcpServers);
  }, [mcpServers]);

  useEffect(() => {
    saveAgents(agents);
  }, [agents]);

  useEffect(() => {
    saveActiveAgentId(activeAgent?.id ?? null);
  }, [activeAgent?.id]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => saveConversations(latestConversationsRef.current),
      CONVERSATION_SAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [conversations]);

  useEffect(() => {
    if (streamingLockRef.current) scheduleStreamingDurableSave(conversations);
  }, [conversations]);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!streamingLockRef.current) return;
      flushStreamingDurableSave();
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [syncLocalVersion, localBackupReady]);

  useEffect(
    () => () => {
      if (streamingLockRef.current) {
        saveConversations(latestConversationsRef.current);
      }
      if (streamingSaveTimerRef.current !== null) {
        window.clearTimeout(streamingSaveTimerRef.current);
        streamingSaveTimerRef.current = null;
      }
      pendingStreamingSaveRef.current = null;
      setStreamingLock(false);
    },
    [],
  );

  useEffect(() => {
    function saveLatestConversations() {
      if (streamingLockRef.current) {
        flushStreamingDurableSave();
      } else {
        saveConversations(latestConversationsRef.current);
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") saveLatestConversations();
    }

    window.addEventListener("pagehide", saveLatestConversations);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", saveLatestConversations);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(
      () => setBeijingTime(formatBeijingClock()),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshWeather() {
      const label = await fetchWeatherLabelFromMcp(mcpServers);
      if (!cancelled && label) setWeatherLabel(label);
    }

    void refreshWeather();
    const timer = window.setInterval(() => void refreshWeather(), 30 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [mcpServers]);

  useEffect(() => {
    const nextUrls = collectObjectAudioUrls(conversations);
    for (const url of voiceAudioUrlsRef.current) {
      if (!nextUrls.has(url)) URL.revokeObjectURL(url);
    }
    voiceAudioUrlsRef.current = nextUrls;
  }, [conversations]);

  useEffect(
    () => () => {
      for (const url of voiceAudioUrlsRef.current) URL.revokeObjectURL(url);
      voiceAudioUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    saveActiveConversationId(activeConversation?.id ?? null);
  }, [activeConversation?.id]);

  useEffect(() => {
    if (!pendingSearchMessageId) return;
    const timer = window.setTimeout(() => {
      const element = document.getElementById(`msg-${pendingSearchMessageId}`);
      if (!element) return;
      element.scrollIntoView({
        behavior: isMobileStreamDevice() ? "auto" : "smooth",
        block: "center",
      });

setPendingSearchMessageId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeConversation?.id, messages.length, pendingSearchMessageId]);

  useEffect(() => {
    if (!localBackupReady) return;

    let cancelled = false;

    async function recoverActiveAiGatewayRun() {
      const activeRun = loadActiveAiGatewayRun();
      if (!activeRun) return;
      if (!canUseAiGateway(syncSettings, currentProvider)) return;

      const providerConfig =
        providers.find((provider) => provider.id === activeRun.providerId) ??
        currentProvider;
      if (!providerConfig || providerConfig.kind !== "openai-compatible") return;

      try {
        const record = await pullAiGatewayRun(syncSettings, activeRun.runId);
        if (cancelled || !record) return;

        let textBuf = "";
        let thinkingBuf = "";
        let finalUsage: UIMessage["usage"] = undefined;
        for await (const chunk of streamChunksFromAiGatewayRun(
          providerConfig,
          record,
        )) {
          if (chunk.usage) finalUsage = mergeUsage(finalUsage, chunk.usage);
          if (chunk.done) break;
          if (chunk.kind === "thinking") thinkingBuf += chunk.delta;
          if (chunk.kind === "text") textBuf += chunk.delta;
        }

        const recoveredText = stripMultiMessageTags(textBuf);
        const recoveredBlocks = assistantBlocksWithTools(
          thinkingBuf,
          recoveredText,
          [],
          false,
          DEFAULT_VOICE_MESSAGE_BUDGET_TOKENS,
        );
        if (record.status === "error" && record.error && recoveredBlocks.length === 0) {
          recoveredBlocks.push({ type: "text", text: `Error: ${record.error}` });
        }
        if (recoveredBlocks.length === 0) return;

        const recoveredMessage: UIMessage = {
          id: activeRun.assistantMessageId,
          role: "assistant",
          model: activeRun.model,
          content: recoveredBlocks,
          createdAt: activeRun.createdAt,
          usage: finalUsage,
          streaming: record.status === "streaming",
        };

        setConversations((previous) =>
          previous.map((conversation) => {
            if (conversation.id !== activeRun.conversationId) return conversation;

            const messageIndex = conversation.messages.findIndex(
              (message) => message.id === activeRun.assistantMessageId,
            );
            if (messageIndex === -1) {
              return {
                ...conversation,
                messages: [...conversation.messages, stripTransient(recoveredMessage)],
                updatedAt: Date.now(),
              };
            }

            const currentMessage = conversation.messages[messageIndex];
            const bestMessage = pickMergedMessage(
              stripTransient(recoveredMessage),
              currentMessage,
            );
            if (bestMessage === currentMessage) return conversation;
            const nextMessages = [...conversation.messages];
            nextMessages[messageIndex] = syncActiveAssistantAlternative(bestMessage);
            return {
              ...conversation,
              messages: nextMessages,
              updatedAt: Date.now(),
            };
          }),
        );

        if (record.status !== "streaming") {
          clearActiveAiGatewayRun(activeRun.runId);
        }
        setSyncStatus(
          record.status === "streaming"
            ? "Recovered an in-progress AI reply from the gateway."
            : "Recovered the last AI reply from the gateway.",
        );
      } catch (error: unknown) {
        console.warn(
          "[ai-gateway-recover]",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    void recoverActiveAiGatewayRun();
    return () => {
      cancelled = true;
    };
  }, [localBackupReady]);

  // ─── Cloud Gateway 断线恢复逻辑 ────────────────────────────────────────────
  useEffect(() => {
    if (!localBackupReady) return;
    let cancelled = false;

    async function recoverActiveCloudRun() {
      const activeRun = loadActiveCloudRun();
      if (!activeRun) return;
      if (!syncSettings.endpoint.trim() || syncSettings.syncCode.trim().length < 8) return;

      // runId 为 "pending_..." 说明网络请求还没发出去就刷新了，直接清掉
      if (activeRun.runId.startsWith("pending_")) {
        clearActiveCloudRun();
        return;
      }

      try {
        const record = await getCloudRun(syncSettings, activeRun.runId);
        if (cancelled || !record) {
          clearActiveCloudRun();
          return;
        }

        // 从 Worker 存的 contentText/thinkingText 直接还原 blocks
        const recoveredBlocks = assistantBlocksWithTools(
          record.thinkingText || "",
          stripMultiMessageTags(record.contentText || ""),
          [],
          false,
          DEFAULT_VOICE_MESSAGE_BUDGET_TOKENS,
        );

        if (record.status === "error" && record.error && recoveredBlocks.length === 0) {
          recoveredBlocks.push({ type: "text", text: `Error: ${record.error}` });
        }
        if (recoveredBlocks.length === 0 && record.status !== "streaming") {
          clearActiveCloudRun();
          return;
        }

        const recoveredMessage: UIMessage = {
          id: activeRun.assistantMessageId,
          role: "assistant",
          model: activeRun.model,
          content: recoveredBlocks,
          createdAt: activeRun.createdAt,
          usage: record.usage ?? undefined,
          streaming: record.status === "streaming",
        };

        setConversations((previous) =>
          previous.map((conversation) => {
            if (conversation.id !== activeRun.conversationId) return conversation;

            const messageIndex = conversation.messages.findIndex(
              (message) => message.id === activeRun.assistantMessageId,
            );

            if (messageIndex === -1) {
              return {
                ...conversation,
                messages: [...conversation.messages, stripTransient(recoveredMessage)],
                updatedAt: Date.now(),
              };
            }

            const currentMessage = conversation.messages[messageIndex];
            const bestMessage = pickMergedMessage(
              stripTransient(recoveredMessage),
              currentMessage,
            );
            if (bestMessage === currentMessage) return conversation;
            const nextMessages = [...conversation.messages];
            nextMessages[messageIndex] = syncActiveAssistantAlternative(bestMessage);
            return {
              ...conversation,
              messages: nextMessages,
              updatedAt: Date.now(),
            };
          }),
        );

        if (record.status !== "streaming") {
          clearActiveCloudRun();
        }

        setSyncStatus(
          record.status === "streaming"
            ? "Recovered an in-progress AI reply from the cloud gateway."
            : "Recovered the last AI reply from the cloud gateway.",
        );
      } catch (error: unknown) {
        console.warn(
          "[cloud-gateway-recover]",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    void recoverActiveCloudRun();
    return () => {
      cancelled = true;
    };
  }, [localBackupReady]);

  async function persistVoiceAudio(
    blob: Blob,
    voiceBlockId: string,
  ): Promise<{ audioUrl: string; audioRef?: CedarSyncBlobRef }> {
    if (canUseSyncBlobStorage(syncSettings)) {
      try {
        const audioRef = await pushSyncBlob(
          syncSettings,
          newVoiceBlobId(voiceBlockId),
          blob,
        );
        return {
          audioUrl: URL.createObjectURL(blob),
          audioRef,
        };
      } catch {
        // Keep voice playback working even if cloud blob storage is unavailable.
      }
    }

    return {
      audioUrl: await audioBlobToDataUrl(blob),
    };
  }

  async function synthesizeVoiceBlocks(
    conversationId: string,
    messageId: string,
    content: ContentBlock[],
    signal?: AbortSignal,
  ) {
    for (const block of content) {
      if (block.type !== "voice" || block.status !== "pending") continue;

      try {
        if (!activeTtsProfile) {
          throw new Error("Select a TTS voice profile first.");
        }
        const audioBlob = await synthesizeSpeech(
          activeTtsProfile,
          block.text,
          signal,
        );
        const { audioUrl, audioRef } = await persistVoiceAudio(
          audioBlob,
          block.id,
        );
        updateVoiceBlock(conversationId, messageId, block.id, {
          status: "ready",
          audioUrl,
          audioRef,
        });
        requestVoiceAutoplay(block.id);
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        updateVoiceBlock(conversationId, messageId, block.id, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  function updateVoiceBlock(
    conversationId: string,
    messageId: string,
    voiceBlockId: string,
    patch: Partial<VoiceBlock>,
  ) {
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === conversationId
          ? {
              ...conversation,
	              messages: conversation.messages.map((message) =>
	                message.id === messageId
	                  ? syncActiveAssistantAlternative({
	                      ...message,
	                      content: message.content.map((block) =>
	                        block.type === "voice" && block.id === voiceBlockId
	                          ? { ...block, ...patch }
	                          : block,
	                      ),
	                    })
	                  : message,
	              ),
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );
  }

  function requestVoiceAutoplay(voiceBlockId: string) {
    if (requestedVoiceAutoplayRef.current.has(voiceBlockId)) return;
    requestedVoiceAutoplayRef.current.add(voiceBlockId);
    setAutoPlayVoiceBlockIds((prev) => {
      if (prev.has(voiceBlockId)) return prev;
      const next = new Set(prev);
      next.add(voiceBlockId);
      return next;
    });
  }

  function consumeVoiceAutoplay(voiceBlockId: string) {
    setAutoPlayVoiceBlockIds((prev) => {
      if (!prev.has(voiceBlockId)) return prev;
      const next = new Set(prev);
      next.delete(voiceBlockId);
      return next;
    });
  }

  async function runAssistantStream(
    conversationId: string,
    promptMessages: StoredMessage[],
    assistantMessage: UIMessage,
    systemContent: ChatTextContentPart[] | undefined,
    contextPromptCache: ClaudePromptCacheTTL,
    injectCurrentTime: boolean,
    shouldGenerateTitle = false,
  ) {
    if (!currentProvider || !selectedModel || busy) return;
    setStreamingLock(true);
    setBusy(true);
    persistConversationSnapshotNow();

    const controller = new AbortController();
    abortRef.current = controller;
    const assistantMessageId = assistantMessage.id;
    let clearQueuedAssistantCommit: () => void = () => undefined;
    let streamCompletedNormally = false;

    try {
      const provider = createProvider(currentProvider);
      const cap = getCapability(selectedModel);
      // Cloud Gateway (新): 优先使用云端网关，解决浏览器刷新截断问题
      const cloudGatewayEnabled =
        currentProvider.kind === "openai-compatible" &&
        syncSettings.endpoint.trim() &&
        syncSettings.syncCode.trim().length >= 8 &&
        (await cloudGatewayAvailable(syncSettings));
      // Legacy AI Gateway (旧，兼容保留)
      const aiGatewayEnabled =
        !cloudGatewayEnabled &&
        canUseAiGateway(syncSettings, currentProvider) &&
        (await aiGatewayAvailable(syncSettings));
      const activeMcpTools = await prepareMcpTools(mcpServers);
      const toolSearchCorpus = chatHistorySearchCorpus(
        conversations,
        conversationId,
        promptMessages,
      );
      const mcpToolByName = new Map(
        activeMcpTools.map((tool) => [tool.functionName, tool]),
      );
      const chatTools = [
        CHAT_HISTORY_SEARCH_TOOL,
        ...activeMcpTools.map((tool) => tool.chatTool),
      ];

      // 构造请求 - 只传当前模型实际支持的字段，剩下的 provider 内部会再过一遍
      // historyDepth: 取最后 N 条上下文；普通发送时 promptMessages 已经包含新用户消息
      const trimmed =
        preferences.historyDepth === "all"
          ? promptMessages
          : promptMessages.slice(-Math.max(preferences.historyDepth + 1, 1));
      const contextCacheEnabled =
        claudeCacheAvailable && contextPromptCache !== "off";
      const currentTimeAfterCache =
        contextCacheEnabled && injectCurrentTime;

      // Pin/Summary: 如果有 pinnedSummary，发 [summary pair] + [post-pin messages].
      // Context cache 只决定是否加 cache_control；pin 截断本身不依赖缓存开关。
      const pinnedSummary =
        activeConversation?.id === conversationId
          ? activeConversation.pinnedSummary
          : null;
      let requestMessages: ChatMessage[];

      if (pinnedSummary) {
        const pinIdx = promptMessages.findIndex(
          (m) => m.id === pinnedSummary.pinnedAtMessageId,
        );
        const postPinSource = pinIdx >= 0 ? promptMessages.slice(pinIdx) : trimmed;
        const postPinMessages: ChatMessage[] =
          postPinSource.map((m) => ({
            role: m.role,
            content: requestContentFromBlocks(m.content),
          }));

        const summaryText =
          pinnedSummary.text.trim() ||
          "There were no earlier messages before the pinned point.";
        const cacheCtrl = contextCacheEnabled
          ? cacheControlForTTL(contextPromptCache)
          : undefined;
        const summaryUserMessage: ChatMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text: `<conversation-summary>\n${summaryText}\n</conversation-summary>\n\nThe above is a summary of our earlier conversation. Continue from here.`,
              ...(cacheCtrl ? { cache_control: cacheCtrl } : {}),
            },
          ],
        };
        const summaryAssistantMessage: ChatMessage = {
          role: "assistant",
          content: "Understood. I have the context from our earlier conversation. Let's continue.",
        };

        requestMessages = [
          summaryUserMessage,
          summaryAssistantMessage,
          ...postPinMessages,
        ];
      } else {
        requestMessages = trimmed.map((m) => ({
          role: m.role,
          content: requestContentFromBlocks(m.content),
        }));
      }
      
      const finalRequestMessages = currentTimeAfterCache
        ? withCacheControlOnLastMessage(
            requestMessages,
            contextPromptCache,
            currentTimePromptContent(),
          )
        : requestMessages;
      // Inject userStyle into the last user message (like Claude AI)
      // Inject userStyle into the last user message (like Claude AI)
      let modelMessages: ChatMessage[] = finalRequestMessages;
      if (userStyle.trim()) {
        const styleText = `<userStyle>${userStyle.trim()}</userStyle>`;
        const lastUserIdx = modelMessages.map((m) => m.role).lastIndexOf("user");
        if (lastUserIdx >= 0) {
          const msg = modelMessages[lastUserIdx];
          const parts: ChatContentPart[] = Array.isArray(msg.content)
            ? msg.content
            : [{ type: "text", text: msg.content ?? "" }];
          parts.push({ type: "text", text: styleText });
          modelMessages = modelMessages.map((m, i) =>
            i === lastUserIdx ? { ...m, content: parts } : m,
          );
        }
      }

      // 流式累积
      let textBuf = "";
      let thinkingBuf = "";
      let toolBlocks: ToolBlock[] = [];
      let finalUsage: UIMessage["usage"] = undefined;
      let stoppedByToolRoundLimit = false;
      let retryWithoutToolsAttempted = false;
      let queuedAssistantBlocks: ContentBlock[] | null = null;
      let queuedAssistantCommitTimer: number | null = null;
      let lastAssistantCommitAt = 0;

      clearQueuedAssistantCommit = () => {
        if (queuedAssistantCommitTimer !== null) {
          window.clearTimeout(queuedAssistantCommitTimer);
          queuedAssistantCommitTimer = null;
        }
        queuedAssistantBlocks = null;
      };

      const writeAssistantBlocks = (blocks: ContentBlock[]) => {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
	                  messages: c.messages.map((m) =>
	                    m.id === assistantMessageId
	                      ? syncActiveAssistantAlternative({
	                          ...m,
	                          content: blocks,
	                          usage: finalUsage,
	                        })
	                      : m,
	                  ),
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
      };

      const flushQueuedAssistantBlocks = () => {
        if (!queuedAssistantBlocks) return;
        const blocks = queuedAssistantBlocks;
        queuedAssistantBlocks = null;
        if (queuedAssistantCommitTimer !== null) {
          window.clearTimeout(queuedAssistantCommitTimer);
          queuedAssistantCommitTimer = null;
        }
        lastAssistantCommitAt = performance.now();
        writeAssistantBlocks(blocks);
      };
	  
      
      const currentStreamCommitInterval = () => {
        const textLength = textBuf.length + thinkingBuf.length;
        const isMobile = isMobileStreamDevice();
      
        if (isMobile) {
          const baseInterval = getMobileSafeCommitInterval(textLength);
      
          // 手机端如果切到后台/锁屏边缘状态，减少 UI commit 压力。
          // 回前台时我们会再 flush。
          if (isDocumentHidden()) {
            return Math.max(baseInterval, 2000);
          }

          return baseInterval;
        }

        if (textLength >= STREAM_HUGE_TEXT_CHARS) return STREAM_HUGE_COMMIT_INTERVAL_MS;
        if (textLength >= STREAM_LARGE_TEXT_CHARS) return STREAM_LARGE_COMMIT_INTERVAL_MS;
        return STREAM_COMMIT_INTERVAL_MS;
      };
		
      const queueAssistantBlocks = (blocks: ContentBlock[]) => {
        queuedAssistantBlocks = blocks;
      
        // 桌面正常；手机端如果页面可见且积累了内容，按节流刷新。
        const commitInterval = currentStreamCommitInterval();
        const elapsed = performance.now() - lastAssistantCommitAt;
      
        if (elapsed >= commitInterval) {
          flushQueuedAssistantBlocks();
          return;
        }
      
        if (queuedAssistantCommitTimer === null) {
          queuedAssistantCommitTimer = window.setTimeout(
            flushQueuedAssistantBlocks,
            Math.max(0, commitInterval - elapsed),
          );
        }
      };

      const commitAssistantBlocks = (blocks: ContentBlock[]) => {
        clearQueuedAssistantCommit();
        lastAssistantCommitAt = performance.now();
        writeAssistantBlocks(blocks);
      };

      const replaceAssistantMessages = (assistantMessages: StoredMessage[]) => {
        clearQueuedAssistantCommit();
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.flatMap((m) => {
                    if (m.id !== assistantMessageId) return [m];
                    const [firstAssistantMessage, ...extraAssistantMessages] =
                      assistantMessages;
                    if (!firstAssistantMessage) return [];
                    if (assistantAlternativeCount(m) <= 1) {
                      return assistantMessages;
                    }
                    return [
                      syncActiveAssistantAlternative({
                        ...m,
                        model: firstAssistantMessage.model,
                        content: firstAssistantMessage.content,
                        createdAt: firstAssistantMessage.createdAt,
                        usage: firstAssistantMessage.usage,
                      }),
                      ...extraAssistantMessages,
                    ];
                  }),
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
      };

      const commonRequest = {
        model: selectedModel,
        systemContent,
        promptCache:
          contextCacheEnabled &&
          !currentTimeAfterCache
            ? {
                type: "ephemeral" as const,
                ...(promptCacheTTL(contextPromptCache) === "1h"
                  ? { ttl: "1h" as const }
                  : {}),
              }
            : undefined,
        temperature: cap.supportsSampling ? temperature : undefined,
        reasoning:
          cap.isReasoning && reasoningEnabled
            ? (() => {
                // 二选一：同上一段 UI 的逻辑保持一致
                const useEffort =
                  cap.thinkingEffort &&
                  (!cap.thinkingBudget || thinkingMode === "effort");
                const useBudget =
                  cap.thinkingBudget &&
                  (!cap.thinkingEffort || thinkingMode === "budget");
                return {
                  enabled: true,
                  effort: useEffort ? effort : undefined,
                  budgetTokens: useBudget ? budgetTokens : undefined,
                };
              })()
            : undefined,
        tools: chatTools.length > 0 ? chatTools : undefined,
        toolChoice: chatTools.length > 0 ? ("auto" as const) : undefined,
        maxTokens: 16384,
        signal: controller.signal,
      };


      for (let round = 0; round < MAX_MCP_TOOL_ROUNDS; round += 1) {
        const requestForRound = {			
			...commonRequest,
          messages: modelMessages,
        };

	    if (round > 0) alert(`第${round+1}轮 modelMessages:\n` + JSON.stringify(modelMessages.map(m => ({role: m.role, hasContent: !!m.content, hasToolCalls: !!(m as any).tool_calls, toolCallId: (m as any).tool_call_id})), null, 2));
		  
        const gatewayRunId = aiGatewayEnabled
          ? newAiGatewayRunId(assistantMessageId, round)
          : null;
        if (gatewayRunId) {
          saveActiveAiGatewayRun({
            runId: gatewayRunId,
            providerId: currentProvider.id,
            conversationId,
            assistantMessageId,
            model: selectedModel,
            createdAt: assistantMessage.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        }

        // ─── Cloud Gateway Stream (新) ─────────────────────────────────────
        let stream: AsyncIterable<import("./providers/types").ChatStreamChunk>;
        if (cloudGatewayEnabled) {
          // 保存 activeCloudRun 用于刷新后恢复
          saveActiveCloudRun({
            runId: `pending_${assistantMessageId}_${round}`,
            conversationId,
            assistantMessageId,
            model: selectedModel,
            providerId: currentProvider.id,
            createdAt: assistantMessage.createdAt ?? Date.now(),
          });
          const pinnedSummary =
            activeConversation?.id === conversationId
              ? (activeConversation.pinnedSummary ?? null)
              : null;
          const cloudRequest: CloudGenerateRequest = {
            upstream: {
              baseUrl: currentProvider.baseUrl,
              apiKey: currentProvider.apiKey,
            },
            model: selectedModel,
            agent: activeAgent
              ? {
                  profile: activeAgent.profile,
                  memory: activeAgent.memory,
                  instructions: activeAgent.instructions,
                  worldBook: activeAgent.worldBook,
                }
              : null,
            userStyle: userStyle.trim() || undefined,
            injectCurrentTime: requestForRound.messages.length > 0 && injectCurrentTime,
            messages: promptMessages,
            // 工具循环的第 2 轮起：modelMessages 已经包含本地执行的 tool 结果，
            // 必须原样透传给上游，否则模型看不到工具返回会无限重复调用。
            // 第 1 轮 (round === 0) 不传，让 Worker 按常规组装 system/pin/style/depth。
            overrideMessages: round > 0 ? (modelMessages as any) : undefined,
            pinnedSummary,
            historyDepth: preferences.historyDepth,
            temperature: requestForRound.temperature,
            reasoning: requestForRound.reasoning as any,
            maxTokens: requestForRound.maxTokens,
            contextPromptCache: contextPromptCache !== "off" ? contextPromptCache : undefined,
            agentPromptCache: activeAgentPromptCache !== "off" ? activeAgentPromptCache : undefined,
            tools: requestForRound.tools as any,
            toolChoice: requestForRound.toolChoice as string,
            clientOnlyTools: [CHAT_HISTORY_SEARCH_TOOL_NAME],
            conversationId,
            assistantMessageId,
          };
          stream = streamViaCloudGateway({
            settings: syncSettings,
            request: cloudRequest,
            signal: controller.signal,
          });
        } else if (gatewayRunId) {
          // ─── Legacy AI Gateway Stream (旧，保留兼容) ───────────────────
          stream = streamOpenAICompatibleViaGateway({
            settings: syncSettings,
            providerConfig: currentProvider,
            request: requestForRound,
            runId: gatewayRunId,
          });
        } else {
          // ─── Direct Provider Stream (无网关时) ─────────────────────────
          stream = provider.streamMessage(requestForRound);
        }
        let roundText = "";
        let toolCalls: ChatToolCall[] = [];
        let roundThinking = "";  

        for await (const chunk of stream) {
          if (chunk.usage) finalUsage = mergeUsage(finalUsage, chunk.usage);
          if (chunk.kind === "tool_calls") {
            toolCalls = chunk.toolCalls ?? [];
            continue;
          }
          if (chunk.done) break;
          if (chunk.kind === "thinking") thinkingBuf += chunk.delta;
          if (chunk.kind === "text") {
            textBuf += chunk.delta;
            roundText += chunk.delta;
			roundThinking += chunk.delta;
          }

          queueAssistantBlocks(
            assistantBlocksWithTools(
              thinkingBuf,
              multiMessageEnabled ? stripMultiMessageTags(textBuf) : textBuf,
              toolBlocks,
              false,
              voiceMessageBudgetTokens,
            ),
          );
        }

        if (toolCalls.length === 0) {
          if (round === 0 && chatTools.length > 0 && !textBuf.trim() && !thinkingBuf.trim()) {
            // Check if messages contain image attachments
            const hasImageInMessages = modelMessages.some((m) => {
              if (!Array.isArray(m.content)) return false;
              return (m.content as ChatContentPart[]).some(
                (p) => p.type === "image_url",
              );
            });

            if (hasImageInMessages && !retryWithoutToolsAttempted) {
              // Image + tools combination caused empty response — retry without tools
              retryWithoutToolsAttempted = true;
              const retryRequest = {
                ...commonRequest,
                tools: undefined,
                toolChoice: undefined,
                messages: modelMessages,
              };

              let retryStream: AsyncIterable<import("./providers/types").ChatStreamChunk>;
              retryStream = provider.streamMessage(retryRequest);

              for await (const chunk of retryStream) {
                if (chunk.done) break;
                if (chunk.kind === "thinking") thinkingBuf += chunk.delta;
                if (chunk.kind === "text") textBuf += chunk.delta;
                queueAssistantBlocks(
                  assistantBlocksWithTools(
                    thinkingBuf,
                    multiMessageEnabled ? stripMultiMessageTags(textBuf) : textBuf,
                    toolBlocks,
                    false,
                    voiceMessageBudgetTokens,
                  ),
                );
              }

              if (!textBuf.trim() && !thinkingBuf.trim()) {
                textBuf +=
                  "\n\nError: the model returned an empty response. This may be caused by the image being too large or in an unsupported format. Try a different model or reduce the image size.";
              }
            } else if (!hasImageInMessages) {
              textBuf +=
                "\n\nError: the model ended before returning text or an MCP tool call. Try a tool-calling model, or disable Thinking for this chat and retry.";
            } else {
              textBuf +=
                "\n\nError: the model returned an empty response even without tools. The image may be unsupported by this provider. Try a different model.";
            }
          }
          break;
        }


		modelMessages = [
		  ...modelMessages,
		  {
		    role: "assistant",
 		   content: roundText || null,
 		   tool_calls: toolCalls,
 		   ...(roundThinking
  		    ? {
   		       reasoning_content: roundThinking,  // DeepSeek 要求
  		        reasoning: roundThinking,           // OpenRouter / 通用
   		     }
  		    : {}),
		  },
		];	

        for (const toolCall of toolCalls) {
          const activeTool = mcpToolByName.get(toolCall.function.name);
          const isHistorySearchTool =
            toolCall.function.name === CHAT_HISTORY_SEARCH_TOOL_NAME;
          const toolBlockName = isHistorySearchTool
            ? "Chat history search"
            : (activeTool?.displayName ?? toolCall.function.name);
          const toolBlockInput = formatToolInput(toolCall.function.arguments);
          toolBlocks = [
            ...toolBlocks,
            {
              type: "tool",
              id: toolCall.id,
              name: toolBlockName,
              status: "pending",
              input: toolBlockInput,
            },
          ];
          commitAssistantBlocks(
            assistantBlocksWithTools(
              thinkingBuf,
              multiMessageEnabled ? stripMultiMessageTags(textBuf) : textBuf,
              toolBlocks,
              false,
              voiceMessageBudgetTokens,
            ),
          );
          let toolResultText: string;

          if (isHistorySearchTool) {
            try {
              const args = parseToolArguments(toolCall.function.arguments);
              toolResultText = runChatHistorySearchTool(
                args,
                toolSearchCorpus,
                conversationId,
              );
              toolBlocks = toolBlocks.map((block) =>
                block.id === toolCall.id
                  ? {
                      ...block,
                      status: "success",
                      output: limitToolBlockText(toolResultText),
                    }
                  : block,
              );
            } catch (error: unknown) {
              const detail =
                error instanceof Error ? error.message : String(error);
              toolResultText = `Chat history search failed: ${detail}`;
              toolBlocks = toolBlocks.map((block) =>
                block.id === toolCall.id
                  ? {
                      ...block,
                      status: "error",
                      error: detail,
                    }
                  : block,
              );
            }
          } else if (!activeTool) {
            toolResultText = `MCP tool ${toolCall.function.name} is not available.`;
            toolBlocks = toolBlocks.map((block) =>
              block.id === toolCall.id
                ? {
                    ...block,
                    status: "error",
                    error: toolResultText,
                  }
                : block,
            );
          } else {
            try {
              const args = parseToolArguments(toolCall.function.arguments);
              const result = await callMcpTool(
                activeTool.server,
                activeTool.toolName,
                args,
                activeTool.sessionId,
              );
              activeTool.sessionId = result.sessionId;
              toolResultText = formatMcpToolResult(result.result);
              toolBlocks = toolBlocks.map((block) =>
                block.id === toolCall.id
                  ? {
                      ...block,
                      status: "success",
                      output: limitToolBlockText(toolResultText),
                    }
                  : block,
              );
            } catch (error: unknown) {
              const detail =
                error instanceof Error ? error.message : String(error);
              toolResultText = `MCP tool ${activeTool.displayName} failed: ${detail}`;
              toolBlocks = toolBlocks.map((block) =>
                block.id === toolCall.id
                  ? {
                      ...block,
                      status: "error",
                      error: detail,
                    }
                  : block,
              );
            }
          }
          commitAssistantBlocks(
            assistantBlocksWithTools(
              thinkingBuf,
              multiMessageEnabled ? stripMultiMessageTags(textBuf) : textBuf,
              toolBlocks,
              false,
              voiceMessageBudgetTokens,
            ),
          );

          modelMessages = [
            ...modelMessages,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResultText,
            },
          ];
        }

        // 保留所有历史 tool results 的完整内容，避免模型因看不到旧结果而重复调用。
        // Token 控制走 historyDepth / pin summary 等整体策略，不要局部抹除 tool 消息。

        if (round === MAX_MCP_TOOL_ROUNDS - 1) {
          stoppedByToolRoundLimit = true;
        }
      }

      if (stoppedByToolRoundLimit) {
        textBuf += `\n\nError: stopped after ${MAX_MCP_TOOL_ROUNDS} MCP tool rounds.`;
      }

      const interimBlocks = assistantBlocksWithTools(
          thinkingBuf,
          multiMessageEnabled ? stripMultiMessageTags(textBuf) : textBuf,
          toolBlocks,
          false,
          voiceMessageBudgetTokens,
      );
      commitAssistantBlocks(interimBlocks);

      const canGenerateVoiceMessages =
        voiceMessagesEnabled && ttsVoiceMessagesAvailable;
      const finalContentSets = assistantMessageContentSets(
        thinkingBuf,
        textBuf,
        toolBlocks,
        multiMessageEnabled,
        canGenerateVoiceMessages,
        voiceMessageBudgetTokens,
      );
      const finalAssistantMessages = assistantMessagesFromContentSets(
        assistantMessage,
        finalContentSets,
        finalUsage,
      );
      replaceAssistantMessages(finalAssistantMessages);

      if (canGenerateVoiceMessages) {
        for (const message of finalAssistantMessages) {
          if (!contentHasPendingVoice(message.content)) continue;
          await synthesizeVoiceBlocks(
            conversationId,
            message.id,
            message.content,
            controller.signal,
          );
        }
      }

      if (shouldGenerateTitle && textBuf.trim()) {
        try {
          const assistantTitleText =
            finalAssistantMessages
              .map((message) => contentBlocksToPlainText(message.content, true))
              .filter(Boolean)
              .join("\n\n") || stripMultiMessageTags(textBuf);
          const title = await generateConversationTitle(
            provider,
            selectedModel,
            promptMessages,
            assistantTitleText,
          );
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? { ...c, title, updatedAt: Date.now() }
                : c,
            ),
          );
        } catch {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    title: titleFromPromptMessages(promptMessages),
                    updatedAt: Date.now(),
                  }
                : c,
            ),
          );
        }
      }
      streamCompletedNormally = true;
    } catch (err: unknown) {
      clearQueuedAssistantCommit();
      if (err instanceof DOMException && err.name === "AbortError") {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
	                  messages: c.messages.map((m) =>
	                    m.id === assistantMessageId
	                      ? syncActiveAssistantAlternative({
	                          ...m,
	                          streaming: false,
	                        } as UIMessage)
	                      : m,
	                  ),
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
        return;
      }
      const errText = err instanceof Error ? err.message : String(err);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
	                  m.id === assistantMessageId
	                    ? syncActiveAssistantAlternative({
	                        ...m,
	                        content: [{ type: "text", text: `Error: ${errText}` }],
	                        streaming: false,
	                      } as UIMessage)
	                    : m,
	                ),
                updatedAt: Date.now(),
              }
            : c,
        ),
      );
    } finally {
      setBusy(false);
      abortRef.current = null;
      if (streamCompletedNormally) {
        clearActiveAiGatewayRun();
        clearActiveCloudRun(); // 新：清理云端 run 记录
      }
      releaseStreamingLockAfterSave();
    }
  }

    function detectDocxTranslateIntent(
    text: string,
    attachments: ChatAttachment[],
  ): { isTranslate: boolean; targetLang: string; docxFile?: File } {
    const docxAttachment = attachments.find(
      (a) => a.name?.endsWith(".docx") && a.file,
    );
    if (!docxAttachment?.file) return { isTranslate: false, targetLang: "" };

    const lower = text.toLowerCase();
    const hasIntent =
      lower.includes("翻译") ||
      lower.includes("translate") ||
      lower.includes("转成") ||
      lower.includes("转为");
    if (!hasIntent) return { isTranslate: false, targetLang: "" };

    const langPatterns: [RegExp, string][] = [
      [/英[文语]|english/i, "英文"],
      [/中[文语]|chinese/i, "中文"],
      [/日[文语]|japanese/i, "日文"],
      [/韩[文语]|korean/i, "韩文"],
      [/法[文语]|french/i, "法文"],
      [/德[文语]|german/i, "德文"],
      [/西班牙[文语]|spanish/i, "西班牙文"],
      [/俄[文语]|russian/i, "俄文"],
    ];

    let targetLang = "英文";
    for (const [pattern, lang] of langPatterns) {
      if (pattern.test(text)) {
        targetLang = lang;
        break;
      }
    }

    return { isTranslate: true, targetLang, docxFile: docxAttachment.file };
  }

  function updateAssistantContent(
    conversationId: string,
    messageId: string,
    text: string,
  ) {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== conversationId) return c;
        return {
          ...c,
          messages: c.messages.map((msg) => {
            if (msg.id !== messageId) return msg;
            return { ...msg, content: [{ type: "text" as const, text }] };
          }),
        };
      }),
    );
  }


  

  // --- 发消息 ---
  async function handleSend() {
    if (
      !currentProvider ||
      !selectedModel ||
      !hasUserContent(input, pendingAttachments) ||
      busy ||
      attaching ||
      !activeConversation
    ) return;
    const inputText = input;
    const attachments = pendingAttachments;
        // === docx 翻译自动检测 ===
    const docxTranslateResult = detectDocxTranslateIntent(inputText, attachments);
    if (docxTranslateResult.isTranslate && docxTranslateResult.docxFile) {
      setInput("");
      setPendingAttachments([]);
      const conversationId = activeConversation.id;
      const now = timestampNow();

      const userMsg: UIMessage = {
        id: uid(),
        role: "user",
        content: [
          ...attachments.map(
            (attachment): ContentBlock => ({ type: "attachment", attachment }),
          ),
          ...(inputText.trim()
            ? [{ type: "text" as const, text: inputText }]
            : []),
        ],
        createdAt: now,
      };

      const assistantMsg: UIMessage = {
        id: uid(),
        role: "assistant",
        model: selectedModel,
        content: [{ type: "text", text: "正在解析文档..." }],
        createdAt: now,
      };

      const nextConversations = conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: [
                ...c.messages,
                stripTransient(userMsg),
                stripTransient(assistantMsg),
              ],
              updatedAt: Date.now(),
            }
          : c,
      );
      latestConversationsRef.current = nextConversations;
      setConversations(nextConversations);
      saveConversations(nextConversations);

      try {
        const { parseDocx, translateParagraphs, writeTranslatedDocx, downloadBlob } =
          await import("./lib/docxTranslate");

        const parseResult = await parseDocx(docxTranslateResult.docxFile);

        updateAssistantContent(
          conversationId,
          assistantMsg.id,
          `解析完成，共 ${parseResult.paragraphs.length} 段文本，开始翻译为${docxTranslateResult.targetLang}...`,
        );

        const translated = await translateParagraphs(parseResult.paragraphs, {
          targetLang: docxTranslateResult.targetLang,
          baseUrl: currentProvider.baseUrl,
          apiKey: currentProvider.apiKey,
          model: selectedModel,
          onProgress: (done, total) => {
            updateAssistantContent(
              conversationId,
              assistantMsg.id,
              `翻译进度：${done}/${total} 段...`,
            );
          },
        });

        const blob = await writeTranslatedDocx(parseResult, translated);
        const filename = `${docxTranslateResult.docxFile.name.replace(/\.docx$/i, "")}_${docxTranslateResult.targetLang}.docx`;
        downloadBlob(blob, filename);

        updateAssistantContent(
          conversationId,
          assistantMsg.id,
          `翻译完成！已自动下载 **${filename}**\n\n共翻译 ${parseResult.paragraphs.length} 个段落。`,
        );
      } catch (err: unknown) {
        updateAssistantContent(
          conversationId,
          assistantMsg.id,
          `翻译失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    // === docx 翻译自动检测结束 ===



    

    const userContent: ContentBlock[] = [
      ...attachments.map((attachment): ContentBlock => ({
        type: "attachment",
        attachment,
      })),
      ...(inputText.trim() ? [{ type: "text" as const, text: inputText }] : []),
    ];
    const shouldGenerateTitle = activeConversation.messages.length === 0;
    const now = timestampNow();
    const userMessage: UIMessage = {
      id: uid(),
      role: "user",
      content: userContent,
      createdAt: now,
    };
    const assistantMessage: UIMessage = {
      id: uid(),
      role: "assistant",
      model: selectedModel,
      content: [],
      createdAt: now,
      streaming: true,
    };

    const promptMessages = [...messages, userMessage].map(stripTransient);
    const nextMessages = [...promptMessages, assistantMessage];
    const conversationId = activeConversation.id;
    const nextConversations = conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            title: c.messages.length === 0 ? "Summarizing..." : c.title,
            messages: nextMessages,
            updatedAt: Date.now(),
          }
        : c,
    );
    latestConversationsRef.current = nextConversations;
    setConversations(nextConversations);

    // 立即同步写入 localStorage，防止刷新丢消息
    saveConversations(nextConversations);
    setInput("");
    setPendingAttachments([]);
    setAttachmentError(null);
    await runAssistantStream(
      conversationId,
      promptMessages,
      assistantMessage,
      requestSystemContent(
        activeConversationAgent,
        activeAgentPromptCache,
        claudeCacheAvailable,
        activeConversation.injectCurrentTime,
        activeContextPromptCache,
        multiMessageEnabled,
        voiceMessagesEnabled && ttsVoiceMessagesAvailable,
        voiceMessageBudgetTokens,
      ),
      activeContextPromptCache,
      activeConversation.injectCurrentTime,
      shouldGenerateTitle,
    );
  }

  
  async function handlePinMessage(messageId: string) {
    if (busy || !activeConversation) return;

    if (activeConversation.pinnedSummary?.pinnedAtMessageId === messageId) {
      setPinSummaryError(null);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id
            ? { ...c, pinnedSummary: null, updatedAt: Date.now() }
            : c,
        ),
      );
      return;
    }

    if (!summaryProvider || !selectedSummaryModel) {
      setPinSummaryError({
        conversationId: activeConversation.id,
        messageId,
        message: "Choose a summary model before pinning.",
      });
      return;
    }

    const msgIndex = activeConversation.messages.findIndex(
      (m) => m.id === messageId,
    );
    if (msgIndex < 0) return;

    setBusy(true);
    setPinSummaryError(null);
    try {
      const provider = createProvider(summaryProvider);
      const existingPin = activeConversation.pinnedSummary;
      const existingPinIndex = existingPin
        ? activeConversation.messages.findIndex(
            (m) => m.id === existingPin.pinnedAtMessageId,
          )
        : -1;
      const canExtendExistingSummary = Boolean(
        existingPin && existingPinIndex >= 0 && existingPinIndex < msgIndex,
      );
      const messagesToSummarize = canExtendExistingSummary
        ? activeConversation.messages.slice(existingPinIndex, msgIndex)
        : activeConversation.messages.slice(0, msgIndex);
      const existingSummary = canExtendExistingSummary
        ? existingPin?.text ?? null
        : null;

      const summaryText =
        messagesToSummarize.length > 0
          ? await generatePinSummary(
              provider,
              selectedSummaryModel,
              messagesToSummarize,
              existingSummary,
            )
          : "";

      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeConversation.id
            ? {
                ...c,
                pinnedSummary: {
                  text: summaryText,
                  pinnedAtMessageId: messageId,
                  createdAt: Date.now(),
                },
                updatedAt: Date.now(),
              }
            : c,
        ),
      );
    } catch (err) {
      console.error("Pin summary generation failed:", err);
      setPinSummaryError({
        conversationId: activeConversation.id,
        messageId,
        message:
          err instanceof Error
            ? err.message || "Summary generation failed."
            : String(err) || "Summary generation failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleAttachmentClick() {
    attachmentInputRef.current?.click();
  }

  async function addAttachmentFiles(files: File[]) {
    if (files.length === 0) return;
    setAttaching(true);
    setAttachmentError(null);

    const next: ChatAttachment[] = [];
    const failures: string[] = [];

    for (const file of files) {
      try {
        next.push(await attachmentFromFile(file));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${file.name}: ${detail}`);
      }
    }

    if (next.length > 0) {
      setPendingAttachments((prev) => [...prev, ...next]);
    }
    if (failures.length > 0) {
      setAttachmentError(failures.join("\n"));
    }
    setAttaching(false);
  }

  async function handleAttachmentFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    await addAttachmentFiles(Array.from(files));
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
  }

  function dataTransferHasFiles(dataTransfer: DataTransfer): boolean {
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleChatDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragDepth((depth) => depth + 1);
  }

  function handleChatDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect =
      currentProvider && selectedModel && !busy ? "copy" : "none";
  }

  function handleChatDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragDepth((depth) => Math.max(0, depth - 1));
  }

  function handleChatDrop(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDragDepth(0);
    if (!currentProvider || !selectedModel || busy) return;
    void addAttachmentFiles(Array.from(event.dataTransfer.files));
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((prev) =>
      prev.filter((attachment) => attachment.id !== id),
    );
  }

  function insertIntoChatInput(text: string) {
    if (!text) return;
    const target = chatInputRef.current;
    const start = target?.selectionStart ?? input.length;
    const end = target?.selectionEnd ?? input.length;
    const next = input.slice(0, start) + text + input.slice(end);
    const nextCursor = start + text.length;

    setInput(next);
    requestAnimationFrame(() => {
      chatInputRef.current?.focus();
      chatInputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function clipboardImageFiles(
    clipboardData: DataTransfer,
  ): File[] {
    const files = Array.from(clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length > 0) return files.map(normalizeClipboardImageFile);

    return Array.from(clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .map(normalizeClipboardImageFile);
  }

  function normalizeClipboardImageFile(file: File, index: number): File {
    if (file.name) return file;
    const subtype = file.type.split("/")[1] || "png";
    const extension = subtype === "jpeg" ? "jpg" : subtype;
    return new File([file], `clipboard-image-${Date.now()}-${index + 1}.${extension}`, {
      type: file.type || "image/png",
      lastModified: Date.now(),
    });
  }

  function handleChatPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = clipboardImageFiles(event.clipboardData);
    const text = event.clipboardData.getData("text/plain");

    if (imageFiles.length === 0 && !text) {
      return;
    }

    event.preventDefault();
    if (imageFiles.length > 0) {
      void addAttachmentFiles(imageFiles);
    }
    if (text) {
      insertIntoChatInput(text);
    }
  }

  async function handleSpeakMessage(message: UIMessage) {
    const text = contentBlocksToPlainText(message.content, true);
    if (!text.trim()) return;
    if (!ttsSettings.enabled || !activeTtsProfile) {
      openSettings("tts");
      return;
    }

    if (speakingMessageId === message.id) {
      ttsAbortRef.current?.abort();
      stopBrowserTts();
      setSpeakingMessageId(null);
      return;
    }

    ttsAbortRef.current?.abort();
    stopBrowserTts();
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    setSpeakingMessageId(message.id);
    try {
      await playTts(activeTtsProfile, text, controller.signal);
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        alert(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (ttsAbortRef.current === controller) {
        ttsAbortRef.current = null;
        setSpeakingMessageId(null);
      }
    }
  }

  async function handleGenerateVoiceBlock(
    messageId: string,
    voiceBlockId: string,
  ) {
    if (!activeConversation) return;
    if (!ttsVoiceMessagesAvailable || !activeTtsProfile) {
      openSettings("tts");
      return;
    }

    const message = messages.find((item) => item.id === messageId);
    const block = message?.content.find(
      (item): item is VoiceBlock =>
        item.type === "voice" && item.id === voiceBlockId,
    );
    if (!block) return;

    updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
      status: "pending",
      audioUrl: undefined,
      error: undefined,
    });

    try {
      const audioBlob = await synthesizeSpeech(activeTtsProfile, block.text);
      const { audioUrl, audioRef } = await persistVoiceAudio(
        audioBlob,
        voiceBlockId,
      );
      updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
        status: "ready",
        audioUrl,
        audioRef,
        error: undefined,
      });
    } catch (error: unknown) {
      updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleLoadVoiceBlock(
    messageId: string,
    voiceBlockId: string,
  ) {
    if (!activeConversation) return;

    const message = messages.find((item) => item.id === messageId);
    const block = message?.content.find(
      (item): item is VoiceBlock =>
        item.type === "voice" && item.id === voiceBlockId,
    );
    if (!block?.audioRef) return;

    if (!canUseSyncBlobStorage(syncSettings)) {
      updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
        status: "error",
        error: "Configure sync to load this voice message.",
      });
      openSettings("sync");
      return;
    }

    updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
      status: "pending",
      audioUrl: undefined,
      error: undefined,
    });

    try {
      const audioBlob = await pullSyncBlob(syncSettings, block.audioRef);
      const audioUrl = URL.createObjectURL(audioBlob);
      updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
        status: "ready",
        audioUrl,
        audioRef: block.audioRef,
        error: undefined,
      });
    } catch (error: unknown) {
      updateVoiceBlock(activeConversation.id, messageId, voiceBlockId, {
        status: "error",
        audioRef: block.audioRef,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

	  async function handleRegenerate(messageId: string) {
	    if (!activeConversation || !currentProvider || !selectedModel || busy) return;
	    const index = messages.findIndex((m) => m.id === messageId);
	    if (index === -1 || messages[index].role !== "assistant") return;
	    const previousAssistantMessage = messages[index];

	    const promptMessages = messages.slice(0, index).map(stripTransient);
	    if (!promptMessages.some((m) => m.role === "user")) return;

	    const createdAt = timestampNow();
	    const nextAlternative: StoredMessageAlternative = {
	      id: uid(),
	      model: selectedModel,
	      content: [],
	      createdAt,
	    };
	    const assistantMessage: UIMessage = {
	      ...appendAssistantAlternative(previousAssistantMessage, nextAlternative),
	      id: previousAssistantMessage.id,
	      role: "assistant",
	      model: selectedModel,
	      content: [],
	      createdAt,
	      streaming: true,
	    };
	    const nextMessages = [...promptMessages, assistantMessage];
	    const conversationId = activeConversation.id;

	    const nextConversations = conversations.map((c) =>
	      c.id === conversationId
	        ? { ...c, messages: nextMessages, updatedAt: Date.now() }
	        : c,
	    );
	    latestConversationsRef.current = nextConversations;
	    setConversations(nextConversations);
	    saveConversations(nextConversations);
	    await runAssistantStream(
      conversationId,
      promptMessages,
      assistantMessage,
      requestSystemContent(
        activeConversationAgent,
        activeAgentPromptCache,
        claudeCacheAvailable,
        activeConversation.injectCurrentTime,
        activeContextPromptCache,
        multiMessageEnabled,
        voiceMessagesEnabled && ttsVoiceMessagesAvailable,
        voiceMessageBudgetTokens,
      ),
      activeContextPromptCache,
      activeConversation.injectCurrentTime,
	    );
	  }

	  function handleSwitchAssistantAlternative(messageId: string, direction: -1 | 1) {
	    if (!activeConversation || busy) return;
	    const conversationId = activeConversation.id;
	    const nextConversations = conversations.map((conversation) =>
	      conversation.id === conversationId
	        ? {
	            ...conversation,
	            messages: conversation.messages.map((message) =>
	              message.id === messageId && message.role === "assistant"
	                ? switchAssistantAlternative(message, direction)
	                : message,
	            ),
	            updatedAt: Date.now(),
	          }
	        : conversation,
	    );
	    latestConversationsRef.current = nextConversations;
	    setConversations(nextConversations);
	    saveConversations(nextConversations);
	  }

	  async function handleContinue() {
    if (!activeConversation || !currentProvider || !selectedModel || busy || messages.length === 0) return;
    const promptMessages = messages.map(stripTransient);
    if (promptMessages[promptMessages.length - 1]?.role !== "assistant") return;

    const assistantMessage: UIMessage = {
      id: uid(),
      role: "assistant",
      model: selectedModel,
      content: [],
      createdAt: timestampNow(),
      streaming: true,
    };
    const conversationId = activeConversation.id;
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: [...promptMessages, assistantMessage],
              updatedAt: Date.now(),
            }
          : c,
      ),
    );
    await runAssistantStream(
      conversationId,
      promptMessages,
      assistantMessage,
      requestSystemContent(
        activeConversationAgent,
        activeAgentPromptCache,
        claudeCacheAvailable,
        activeConversation.injectCurrentTime,
        activeContextPromptCache,
        multiMessageEnabled,
        voiceMessagesEnabled && ttsVoiceMessagesAvailable,
        voiceMessageBudgetTokens,
      ),
      activeContextPromptCache,
      activeConversation.injectCurrentTime,
    );
  }

  function startEditing(message: UIMessage) {
    if (busy || message.role !== "user") return;
    setEditingMessageId(message.id);
    setEditingText(textFromContent(message.content));
  }

  function cancelEditing() {
    setEditingMessageId(null);
    setEditingText("");
  }

  async function saveEditedMessage(messageId: string) {
    if (!activeConversation || !currentProvider || !selectedModel || busy || !editingText.trim()) return;
    const index = messages.findIndex((m) => m.id === messageId);
    if (index === -1 || messages[index].role !== "user") return;
    const preservedAttachments = messages[index].content.filter(
      (block): block is Extract<ContentBlock, { type: "attachment" }> =>
        block.type === "attachment",
    );

    const editedMessage: StoredMessage = {
      ...stripTransient(messages[index]),
      content: [...preservedAttachments, { type: "text", text: editingText }],
      createdAt: messages[index].createdAt ?? timestampNow(),
    };
    const promptMessages = [
      ...messages.slice(0, index).map(stripTransient),
      editedMessage,
    ];
    const assistantMessage: UIMessage = {
      id: uid(),
      role: "assistant",
      model: selectedModel,
      content: [],
      createdAt: timestampNow(),
      streaming: true,
    };
    const conversationId = activeConversation.id;
    const shouldRetitle =
      messages.findIndex((m) => m.role === "user") === index;

    setEditingMessageId(null);
    setEditingText("");
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              title: shouldRetitle ? "Summarizing..." : c.title,
              messages: [...promptMessages, assistantMessage],
              updatedAt: Date.now(),
            }
          : c,
      ),
    );
    await runAssistantStream(
      conversationId,
      promptMessages,
      assistantMessage,
      requestSystemContent(
        activeConversationAgent,
        activeAgentPromptCache,
        claudeCacheAvailable,
        activeConversation.injectCurrentTime,
        activeContextPromptCache,
        multiMessageEnabled,
        voiceMessagesEnabled && ttsVoiceMessagesAvailable,
        voiceMessageBudgetTokens,
      ),
      activeContextPromptCache,
      activeConversation.injectCurrentTime,
      shouldRetitle,
    );
  }

  function handleNewConversation() {
    const conversation = createEmptyConversation(activeAgent?.id ?? null);
    setConversations((prev) => [conversation, ...prev]);
    setActiveConversationId(conversation.id);
    setSidebarOpen(false);
    setConversationSearchQuery("");
    setInput("");
    setPendingAttachments([]);
    setAttachmentError(null);
    cancelEditing();
  }

  function handleDeleteConversation(id: string) {
    if (!confirm("Delete this chat?")) return;
    setChatState((previous) => {
      const remaining = previous.conversations.filter((c) => c.id !== id);
      const sameAgent = remaining.filter(
        (conversation) => conversation.agentId === previous.activeAgentId,
      );
      const fallback =
        sameAgent[0] ??
        createEmptyConversation(previous.activeAgentId);
      const conversations =
        sameAgent.length > 0 ? remaining : [fallback, ...remaining];
      const activeConversationId =
        previous.activeConversationId === id
          ? fallback.id
          : previous.activeConversationId;
      return { ...previous, conversations, activeConversationId };
    });
    // 同步删除云端数据（非阻塞，best-effort）
    if (syncSettings.endpoint.trim() && syncSettings.syncCode.trim().length >= 8) {
      deleteCloudConversation(syncSettings, id).catch((err) =>
        console.warn("[cloud-gateway] Failed to delete conversation from cloud:", err),
      );
    }
  }

  function handleOpenExport() {
    setExportSelectedIds(conversations.map((c) => c.id));
    setExportOpen(true);
  }

  function handleWindowSettingsChange(patch: WindowSettingsPatch) {
    if (!activeConversation) return;
    if ("providerId" in patch) setCurrentProviderId(patch.providerId ?? null);
    if ("model" in patch) setCurrentModel(patch.model ?? null);
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
              ...conversation,
              ...patch,
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );
  }

  function handleSummaryProviderChange(providerId: string) {
    if (!activeConversation) return;
    const provider = providers.find((item) => item.id === providerId) ?? null;
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
              ...conversation,
              summaryProviderId: provider?.id ?? null,
              summaryModel: provider?.models[0] ?? null,
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );
  }

  function handleSummaryModelChange(model: string) {
    if (!activeConversation) return;
    setConversations((prev) =>
      prev.map((conversation) =>
        conversation.id === activeConversation.id
          ? {
              ...conversation,
              summaryProviderId: summaryProvider?.id ?? null,
              summaryModel: model || null,
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );
  }

  function toggleExportConversation(id: string) {
    setExportSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }

  function handleExportSelected() {
    const selected = conversations
      .filter((c) => exportSelectedIds.includes(c.id))
      .map(stripTransientConversation);
    if (selected.length === 0) return;

    const payload: ChatExportPayload = {
      app: "cedar-chat",
      version: 1,
      exportedAt: new Date().toISOString(),
      agents: agents.filter((agent) =>
        selected.some((conversation) => conversation.agentId === agent.id),
      ),
      conversations: selected,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `cedar-chat-${date}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  }

  function handleImportClick() {
    importInputRef.current?.click();
  }

  async function handleImportFile(file: File | undefined) {
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const importedAgents = agentsFromImport(parsed);
      const imported = conversationsFromImport(parsed);
      if (imported.length === 0) {
        alert("No Cedar Chat conversations found in this JSON file.");
        return;
      }

      setChatState((previous) => {
        const mergedAgents = [
          ...importedAgents,
          ...previous.agents.filter(
            (agent) =>
              !new Set(importedAgents.map((item) => item.id)).has(agent.id),
          ),
        ];
        const fallbackAgentId =
          importedAgents[0]?.id ??
          previous.activeAgentId ??
          mergedAgents[0]?.id ??
          null;
        const normalizedImported = imported.map((conversation) => ({
          ...conversation,
          agentId: conversation.agentId ?? fallbackAgentId,
          providerId: conversation.providerId ?? loadCurrent().providerId,
          model: conversation.model ?? loadCurrent().model,
          temperature: normalizeTemperature(conversation.temperature),
          reasoningEnabled:
            typeof conversation.reasoningEnabled === "boolean"
              ? conversation.reasoningEnabled
              : DEFAULT_REASONING_ENABLED,
          thinkingMode: normalizeThinkingMode(conversation.thinkingMode),
          thinkingEffort: normalizeThinkingEffort(conversation.thinkingEffort),
          thinkingBudgetTokens: normalizeThinkingBudgetTokens(
            conversation.thinkingBudgetTokens,
          ),
          agentPromptCache: normalizeClaudePromptCacheTTL(
            conversation.agentPromptCache,
            splitLegacyPromptCacheMode(conversation.claudePromptCache)
              .agentPromptCache,
          ),
          contextPromptCache: normalizeClaudePromptCacheTTL(
            conversation.contextPromptCache,
            splitLegacyPromptCacheMode(conversation.claudePromptCache)
              .contextPromptCache,
          ),
          summaryProviderId:
            typeof conversation.summaryProviderId === "string"
              ? conversation.summaryProviderId
              : null,
          summaryModel:
            typeof conversation.summaryModel === "string"
              ? conversation.summaryModel
              : null,
          showMessageTimestamps: conversation.showMessageTimestamps ?? false,
          injectCurrentTime: conversation.injectCurrentTime ?? false,
          multiMessageEnabled:
            conversation.multiMessageEnabled ?? DEFAULT_MULTI_MESSAGE_ENABLED,
          voiceMessagesEnabled:
            conversation.voiceMessagesEnabled ?? DEFAULT_VOICE_MESSAGES_ENABLED,
          voiceMessageBudgetTokens: normalizeVoiceMessageBudgetTokens(
            conversation.voiceMessageBudgetTokens,
          ),
          messages: conversation.messages.map(stripTransient),
        }));
        const importedIds = new Set(normalizedImported.map((c) => c.id));
        const remaining = previous.conversations.filter(
          (c) => !importedIds.has(c.id),
        );
        const conversations = [...normalizedImported, ...remaining];
        const activeAgentId =
          normalizedImported[0]?.agentId ?? previous.activeAgentId;
        return {
          ...previous,
          agents: mergedAgents.length > 0 ? mergedAgents : previous.agents,
          conversations,
          activeAgentId,
          activeConversationId:
            normalizedImported[0]?.id ?? previous.activeConversationId,
        };
      });
      alert(`Imported ${imported.length} chat${imported.length === 1 ? "" : "s"}.`);
    } catch {
      alert("Could not import this JSON file.");
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  function createSyncSnapshot(): CedarSyncSnapshot {
    const deviceName = syncSettings.deviceName.trim();
    const snapshotConversations = latestConversationsRef.current;
    const snapshotActiveConversationId =
      activeConversationId &&
      snapshotConversations.some(
        (conversation) => conversation.id === activeConversationId,
      )
        ? activeConversationId
        : (snapshotConversations[0]?.id ?? null);
    return {
      app: "cedar-chat",
      version: 1,
      exportedAt: new Date().toISOString(),
      ...(deviceName ? { deviceName } : {}),
      current: {
        providerId: activeProviderId ?? currentProviderId,
        model: selectedModel ?? currentModel,
      },
      preferences,
      providers,
      mcpServers,
      ttsSettings,
      agents,
      activeAgentId: activeAgent?.id ?? activeAgentId,
      conversations: snapshotConversations.map(stripTransientConversation),
      activeConversationId: snapshotActiveConversationId,
    };
  }

  function formatSyncSnapshotContents(snapshot: CedarSyncSnapshot): string {
    return `${snapshot.conversations.length} chats, ${snapshot.mcpServers.length} MCP servers`;
  }

  function applySyncSnapshot(snapshot: CedarSyncSnapshot) {
    if (snapshot.app !== "cedar-chat" || snapshot.version !== 1) {
      throw new Error("This is not a Cedar Chat sync snapshot.");
    }

    const nextProviders = providersFromSync(snapshot.providers);
    const nextMcpServers = mcpServersFromSync(snapshot.mcpServers);
    const nextTtsSettings = ttsSettingsFromSync(snapshot.ttsSettings);
    const nextCurrent = currentFromSync(snapshot.current);
    const nextAgents = agentsFromImport(snapshot);
    const agentsToUse = nextAgents.length > 0 ? nextAgents : [createDefaultAgent()];
    const agentIds = new Set(agentsToUse.map((agent) => agent.id));
    const fallbackAgentId =
      snapshot.activeAgentId && agentIds.has(snapshot.activeAgentId)
        ? snapshot.activeAgentId
        : (agentsToUse[0]?.id ?? null);
    const nextConversations = normalizeConversationsForAgents(
      conversationsFromImport(snapshot),
      agentsToUse,
      fallbackAgentId,
      DEFAULT_LEGACY_CLAUDE_PROMPT_CACHE,
    );
    const conversationsToUse = mergeProtectedStreamMessages(
      nextConversations.length > 0
        ? nextConversations
        : [createEmptyConversation(fallbackAgentId)],
    );
    const activeConversationIdToUse =
      snapshot.activeConversationId &&
      conversationsToUse.some(
        (conversation) => conversation.id === snapshot.activeConversationId,
      )
        ? snapshot.activeConversationId
        : (conversationsToUse[0]?.id ?? null);

    setProviders(nextProviders);
    setPreferences(preferencesFromSync(snapshot.preferences));
    setMcpServers(nextMcpServers);
    if (nextTtsSettings) setTtsSettings(nextTtsSettings);
    setCurrentProviderId(nextCurrent.providerId);
    setCurrentModel(nextCurrent.model);
    setChatState({
      agents: agentsToUse,
      activeAgentId: fallbackAgentId,
      conversations: conversationsToUse,
      activeConversationId: activeConversationIdToUse,
    });
  }

  async function handleSyncPush() {
    if (syncBusy) return;
    if (streamProtectionActive()) {
      setSyncStatus("AI reply was just updated. Sync after it is safely saved.");
      return;
    }
    setSyncBusy(true);
    setSyncStatus("Uploading...");
    try {
      const snapshot = createSyncSnapshot();
      const result = await pushSyncSnapshot(syncSettings, snapshot);
      const now = Date.now();
      setSyncSettings((previous) => ({ ...previous, lastPushedAt: now }));
      setSyncStatus(
        `Uploaded ${formatSyncSnapshotContents(snapshot)}${
          result.bytes ? ` (${formatBytes(result.bytes)})` : ""
        }.`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncStatus(message);
    } finally {
      setSyncBusy(false);
    }
  }

  async function handleSyncPull() {
    if (syncBusy) return;
    if (streamProtectionActive()) {
      setSyncStatus("AI reply was just updated. Sync after it is safely saved.");
      return;
    }

    setSyncBusy(true);
    setSyncStatus("Syncing...");
    try {
      const localSnapshot = createSyncSnapshot();
      const localIsEmpty = !hasPersistedMessages(localSnapshot.conversations);
      const cloudSnapshot = await pullSyncSnapshot(syncSettings);
      if (localIsEmpty) {
        if (cloudSnapshot && hasPersistedMessages(cloudSnapshot.conversations)) {
          applySyncSnapshot(cloudSnapshot);
          const now = Date.now();
          setSyncSettings((previous) => ({
            ...previous,
            lastPulledAt: now,
          }));
          setSyncStatus(`Downloaded ${formatSyncSnapshotContents(cloudSnapshot)}.`);
        } else {
          setSyncStatus("No cloud history found.");
        }
        return;
      }

      const mergedSnapshot = cloudSnapshot
        ? mergeSyncSnapshots(localSnapshot, cloudSnapshot)
        : localSnapshot;
      const shouldPush =
        !cloudSnapshot ||
        syncSnapshotDataSignature(mergedSnapshot) !==
          syncSnapshotDataSignature(cloudSnapshot);

      applySyncSnapshot(mergedSnapshot);
      const result = shouldPush
        ? await pushSyncSnapshot(syncSettings, mergedSnapshot)
        : null;
      const now = Date.now();
      setSyncSettings((previous) => ({
        ...previous,
        lastPushedAt: shouldPush ? now : previous.lastPushedAt,
        lastPulledAt: cloudSnapshot ? now : previous.lastPulledAt,
      }));
      setSyncStatus(
        `Synced ${formatSyncSnapshotContents(mergedSnapshot)}${
          result?.bytes ? ` (${formatBytes(result.bytes)})` : ""
        }.`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setSyncStatus(message);
    } finally {
      setSyncBusy(false);
    }
  }

    // --- Auto Sync ---
  useAutoSync(syncSettings, {
    createSnapshot: createSyncSnapshot,
    mergeAndApply: (local, cloud) => mergeSyncSnapshots(local, cloud),
    applySnapshot: applySyncSnapshot,
    isStreaming: streamProtectionActive,
    localVersion: syncLocalVersion,
    onSyncComplete: (pushed, pulled) => {
      const now = Date.now();
      setSyncSettings((prev) => ({
        ...prev,
        lastPushedAt: pushed ? now : prev.lastPushedAt,
        lastPulledAt: pulled ? now : prev.lastPulledAt,
      }));
    },
    onSyncError: (err) => {
      console.warn("[auto-sync]", err.message);
    },
    onSyncStatus: (msg) => {
      if (msg) setSyncStatus(msg);
      else setSyncStatus(null);
    },
  });

  function handleAgentsChange(nextAgents: Agent[]) {
    if (nextAgents.length === 0) return;

    setChatState((previous) => {
      const agentIds = new Set(nextAgents.map((agent) => agent.id));
      const fallbackAgentId = nextAgents[0].id;
      const conversations = previous.conversations.map((conversation) =>
        conversation.agentId && agentIds.has(conversation.agentId)
          ? conversation
          : { ...conversation, agentId: fallbackAgentId },
      );
      const activeAgentId =
        previous.activeAgentId && agentIds.has(previous.activeAgentId)
          ? previous.activeAgentId
          : fallbackAgentId;
      const activeConversation =
        conversations.find((c) => c.id === previous.activeConversationId) ??
        conversations.find((c) => c.agentId === activeAgentId) ??
        createEmptyConversation(activeAgentId);
      const hasActiveConversation = conversations.some(
        (c) => c.id === activeConversation.id,
      );

      return {
        ...previous,
        agents: nextAgents,
        conversations: hasActiveConversation
          ? conversations
          : [activeConversation, ...conversations],
        activeAgentId,
        activeConversationId: activeConversation.id,
      };
    });
  }

  // --- Render ---

  return (
    <div
      className={`cedar-app cedar-display-${preferences.chatDisplayMode}`}
      style={appStyle}
    >
      {sidebarOpen && (
        <button
          type="button"
          className="cedar-mobile-shade"
          aria-label="Close chats"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`cedar-sidebar ${
          sidebarCollapsed ? "cedar-sidebar-collapsed" : ""
        } ${sidebarOpen ? "cedar-sidebar-open" : ""}`}
      >
        <div className="cedar-sidebar-head">
          <div className="cedar-mobile-title">
            <div className="font-semibold">Cedar Chat</div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="cedar-ghost-button"
            >
              Close
            </button>
          </div>
          <div className="cedar-agent-row">
            <select
              className="select cedar-agent-select"
              value={activeAgent?.id ?? ""}
              onChange={(event) => selectAgent(event.target.value)}
              aria-label="Active agent"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => setAgentsOpen(true)}
              className="cedar-icon-button"
              title="Manage agents"
            >
              <span className="cedar-sidebar-label">Agents</span>
              <span className="cedar-sidebar-icon">A</span>
            </button>
          </div>
          <div className="cedar-sidebar-actions">
            <button onClick={handleNewConversation} className="cedar-button">
              <span className="cedar-button-mark">+</span>
              <span className="cedar-sidebar-label">New chat</span>
            </button>
            <button
              type="button"
              onClick={() => setSidebarCollapsed((value) => !value)}
              className="cedar-icon-button cedar-collapse-button"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? ">" : "<"}
            </button>
          </div>
          <div className="cedar-sidebar-search">
            <div className="cedar-search-field">
              <input
                className="input cedar-search-input"
                value={conversationSearchQuery}
                onChange={(event) => setConversationSearchQuery(event.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
              />
              {conversationSearchQuery && (
                <button
                  type="button"
                  className="cedar-search-clear"
                  onClick={() => setConversationSearchQuery("")}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  x
                </button>
              )}
            </div>
            <div className="cedar-search-scope" aria-label="Search scope">
              <button
                type="button"
                className={
                  conversationSearchScope === "agent" ? "active" : undefined
                }
                onClick={() => setConversationSearchScope("agent")}
              >
                Agent
              </button>
              <button
                type="button"
                className={
                  conversationSearchScope === "all" ? "active" : undefined
                }
                onClick={() => setConversationSearchScope("all")}
              >
                All
              </button>
            </div>
          </div>
        </div>
        <nav className="cedar-chat-list">
          {trimmedConversationSearchQuery ? (
            hasConversationSearchResults ? (
              <>
                {titleOnlySearchConversations.map((conversation) => (
                  <div
                    key={`title-${conversation.id}`}
                    className={`cedar-chat-row ${
                      conversation.id === activeConversation?.id
                        ? "cedar-chat-row-active"
                        : ""
                    }`}
                  >
                    <button
                      onClick={() => selectConversation(conversation.id)}
                      className="cedar-chat-select"
                      title={conversation.title}
                    >
                      <span className="cedar-chat-initial">
                        {conversation.title.trim().slice(0, 1).toUpperCase() || "C"}
                      </span>
                      <span className="cedar-chat-copy">
                        <span className="cedar-chat-title">{conversation.title}</span>
                        <span className="cedar-chat-count">
                          title match · {conversation.messages.length} messages
                        </span>
                      </span>
                    </button>
                  </div>
                ))}
                {conversationSearchResults.map((result) => (
                  <div
                    key={`${result.conversationId}-${result.messageId}`}
                    className={`cedar-chat-row cedar-search-result-row ${
                      result.conversationId === activeConversation?.id
                        ? "cedar-chat-row-active"
                        : ""
                    }`}
                  >
                    <button
                      onClick={() =>
                        selectConversation(result.conversationId, result.messageId)
                      }
                      className="cedar-chat-select"
                      title={result.matchText}
                    >
                      <span className="cedar-chat-initial">
                        {result.messageRole === "user" ? "U" : "A"}
                      </span>
                      <span className="cedar-chat-copy">
                        <span className="cedar-chat-title">
                          {result.conversationTitle}
                        </span>
                        <span className="cedar-chat-count">
                          {result.messageRole === "user" ? "You" : "Assistant"} ·{" "}
                          {result.matchText}
                        </span>
                      </span>
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <div className="cedar-search-empty">No matches</div>
            )
          ) : (
            agentConversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`cedar-chat-row ${
                  conversation.id === activeConversation?.id
                    ? "cedar-chat-row-active"
                    : ""
                }`}
              >
                <button
                  onClick={() => selectConversation(conversation.id)}
                  className="cedar-chat-select"
                  title={conversation.title}
                >
                  <span className="cedar-chat-initial">
                    {conversation.title.trim().slice(0, 1).toUpperCase() || "C"}
                  </span>
                  <span className="cedar-chat-copy">
                    <span className="cedar-chat-title">{conversation.title}</span>
                    <span className="cedar-chat-count">
                      {conversation.messages.length} messages
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => handleDeleteConversation(conversation.id)}
                  className="cedar-delete-button"
                  title="Delete chat"
                >
                  x
                </button>
              </div>
            ))
          )}
        </nav>
        <div className="cedar-sidebar-footer">
          <div className="cedar-local-line">
            <span className="cedar-sidebar-label">
              Beijing · {beijingTime} · {weatherLabel}
            </span>
            <span className="cedar-sidebar-icon">BJ</span>
          </div>
          <button onClick={handleOpenExport} className="cedar-button cedar-button-muted">
            <span className="cedar-sidebar-label">Export chats</span>
            <span className="cedar-sidebar-icon">Ex</span>
          </button>
          <button onClick={handleImportClick} className="cedar-button cedar-button-muted">
            <span className="cedar-sidebar-label">Import chats</span>
            <span className="cedar-sidebar-icon">Im</span>
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => handleImportFile(event.target.files?.[0])}
          />
        </div>
      </aside>

      <div
        className="cedar-workspace"
        onDragEnter={handleChatDragEnter}
        onDragOver={handleChatDragOver}
        onDragLeave={handleChatDragLeave}
        onDrop={handleChatDrop}
      >
        {dragDepth > 0 && (
          <div className="cedar-drop-overlay">
            <div className="cedar-drop-card">
              <div className="text-sm font-medium">Drop files to attach</div>
              <div className="mt-1 text-xs text-[var(--text-tertiary)]">
                Images, text, PDF, Python, notebooks and common documents
              </div>
            </div>
          </div>
        )}
        <header className="cedar-topbar">
          <button
            onClick={() => setSidebarOpen(true)}
            className="cedar-icon-button cedar-mobile-menu"
            aria-label="Open chats"
          >
            =
          </button>
          <h1>Cedar Chat</h1>

          <div className="cedar-model-line">
            {currentProvider && selectedModel ? (
              <span>
                {currentProvider.name} · {selectedModel}
              </span>
            ) : (
              <span>No model selected</span>
            )}
          </div>

          <div className="cedar-top-actions">
            <button
              type="button"
              onClick={() => setContextOpen((value) => !value)}
              className="cedar-icon-button"
              aria-label="Toggle context drawer"
              title="Context"
            >
              🐱
            </button>
            <button
              onClick={() => setWindowSettingsOpen(true)}
              disabled={!activeConversation}
              className="cedar-ghost-button"
            >
              <span className="hidden sm:inline">窗口设置</span>
              <span className="sm:hidden">窗口</span>
            </button>
            <button
              onClick={() => openSettings("providers")}
              className="cedar-ghost-button"
            >
              <span className="hidden sm:inline">Providers</span>
              <span className="sm:hidden">P</span>
            </button>
          </div>
        </header>

        <main className="cedar-conversation">
          <div className="cedar-thread">
            {messages.length === 0 && (
              <div className="cedar-empty-state">
                {providers.length === 0 ? (
                  <>
                    No provider configured yet.
                    <br />
                    <button
                      onClick={() => openSettings("providers")}
                      className="cedar-inline-link"
                    >
                      Open Providers
                    </button>
                  </>
                ) : (
                  <>Pick a provider and model, then say hi.</>
                )}
              </div>
            )}
            {messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                busy={busy}
                canChat={Boolean(currentProvider && selectedModel)}
                assistantName={activeConversationAgent?.name ?? "Cedar"}
                modelName={
                  m.role === "assistant"
                    ? (m.model ?? activeConversation?.model ?? selectedModel)
                    : null
                }
	                isEditing={editingMessageId === m.id}
	                editingText={editingText}
	                isLastAssistant={m.id === lastAssistantId}
	                alternativeIndex={
	                  m.role === "assistant" ? activeAssistantAlternativeIndex(m) : 0
	                }
	                alternativeCount={
	                  m.role === "assistant" ? assistantAlternativeCount(m) : 1
	                }
	                canSpeak={m.role === "assistant"}
	                speaking={speakingMessageId === m.id}
	                autoPlayVoiceBlockIds={autoPlayVoiceBlockIds}
                onEditingTextChange={setEditingText}
                onStartEdit={() => startEditing(m)}
                onCancelEdit={cancelEditing}
	                onSaveEdit={() => saveEditedMessage(m.id)}
	                onRegenerate={() => handleRegenerate(m.id)}
	                onAlternativeChange={(direction) =>
	                  handleSwitchAssistantAlternative(m.id, direction)
	                }
	                onContinue={handleContinue}
              onSpeak={() => handleSpeakMessage(m)}
              onGenerateVoiceBlock={(voiceBlockId) =>
                handleGenerateVoiceBlock(m.id, voiceBlockId)
              }
              onLoadVoiceBlock={(voiceBlockId) =>
                handleLoadVoiceBlock(m.id, voiceBlockId)
              }
              onVoiceAutoPlayAttempted={consumeVoiceAutoplay}
            />
            ))}
          </div>
        </main>

        <footer className="cedar-composer-shell">
          <div className="cedar-composer">
            {pendingAttachments.length > 0 && (
              <div className="cedar-attachment-row">
                {pendingAttachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={() => removePendingAttachment(attachment.id)}
                  />
                ))}
              </div>
            )}
            {attachmentError && (
              <div className="cedar-alert">{attachmentError}</div>
            )}
            <div className="cedar-input-area">
              <button
                onClick={handleAttachmentClick}
                disabled={!currentProvider || !selectedModel || attaching || busy}
                className="cedar-tool-button"
                title="Attach files"
              >
                {attaching ? "..." : "+"}
              </button>
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.markdown,.pdf,.py,.ipynb,.json,.csv,.ts,.tsx,.js,.jsx,.html,.css,.xml,.yaml,.yml"
                className="hidden"
                onChange={(event) => handleAttachmentFiles(event.target.files)}
              />
              <textarea
                ref={chatInputRef}
                className="input cedar-chat-input"
                rows={2}
                placeholder={
                  currentProvider && selectedModel
                    ? "Say it quietly..."
                    : "Configure a provider first"
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handleChatPaste}
                disabled={!currentProvider || !selectedModel}
              />
              {busy ? (
                <button onClick={handleStop} className="cedar-stop-button">
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!canSend}
                  className="cedar-send-button cedar-paw-send"
                  aria-label="Send message"
                  title="Send message"
                >
                  <span className="cedar-paw-print" aria-hidden="true">
                    <span className="cedar-paw-toe cedar-paw-toe-1" />
                    <span className="cedar-paw-toe cedar-paw-toe-2" />
                    <span className="cedar-paw-toe cedar-paw-toe-3" />
                    <span className="cedar-paw-toe cedar-paw-toe-4" />
                    <span className="cedar-paw-pad" />
                  </span>
                  <span className="cedar-paw-text">Send</span>
                </button>
              )}
            </div>
          </div>
        </footer>
      </div>

      <aside className={`cedar-context ${contextOpen ? "cedar-context-open" : ""}`}>
        <header className="cedar-context-head">
          <span>Context</span>
          <button
            type="button"
            onClick={() => setContextOpen(false)}
            className="cedar-icon-button"
            aria-label="Close context"
          >
            x
          </button>
        </header>
        <div className="cedar-context-body">
          <section>
            <div className="cedar-context-label">Memory</div>
            <div className="cedar-context-value">
              {contextSections.length > 0
                ? `${contextSections.length} active sections`
                : "No active memory"}
            </div>
          </section>
          <section>
            <div className="cedar-context-label">Active Skills</div>
            <div className="cedar-context-value">
              {enabledMcpServers.length > 0
                ? `${enabledMcpServers.length} MCP server${
                    enabledMcpServers.length === 1 ? "" : "s"
                  }`
                : "No MCP tools"}
            </div>
          </section>
          <section>
            <div className="cedar-context-label">Tokens</div>
            <div className="cedar-context-value">
              {lastUsage
                ? `in ${lastUsage.inputTokens} · out ${lastUsage.outputTokens}`
                : "No usage yet"}
            </div>
          </section>
          <section>
            <div className="cedar-context-label">Cost</div>
            <div
              className="cedar-context-value"
              title={conversationCostEstimate?.title}
            >
              {conversationCostEstimate
                ? `${conversationCostEstimate.label} · ${conversationCostEstimate.count} rounds`
                : "No cost yet"}
            </div>
          </section>
          <section>
            <div className="cedar-context-label">Summary model</div>
            <div className="cedar-context-model-controls">
              <label>
                <span>Provider</span>
                <select
                  className="select"
                  value={activeConversation?.summaryProviderId ?? ""}
                  onChange={(event) =>
                    handleSummaryProviderChange(event.target.value)
                  }
                  disabled={!activeConversation}
                >
                  <option value="">Same as chat</option>
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Model</span>
                <select
                  className="select"
                  value={selectedSummaryModel ?? ""}
                  onChange={(event) =>
                    handleSummaryModelChange(event.target.value)
                  }
                  disabled={!activeConversation || !summaryProvider}
                >
                  <option value="">Select model</option>
                  {summaryProvider?.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          <section>
            <div className="cedar-context-label">Cache</div>
            <div className="cedar-context-value">
              agent {activeAgentPromptCache} · context {activeContextPromptCache}
            </div>
          </section>
          <section>
            <div className="cedar-context-label">
              Messages
              {activeConversation?.pinnedSummary && (
                <span className="cedar-context-pin-status">
                  Pinned
                </span>
              )}
            </div>
            {activeConversation?.pinnedSummary && (
              <details className="cedar-context-summary">
                <summary>Summary</summary>
                <p>
                  {activeConversation.pinnedSummary.text.trim() ||
                    "No earlier messages before this pin."}
                </p>
              </details>
            )}
            {activePinSummaryError && (
              <div className="cedar-context-summary-error">
                <span>Summary failed: {activePinSummaryError.message}</span>
                <button
                  type="button"
                  onClick={() => handlePinMessage(activePinSummaryError.messageId)}
                  disabled={busy}
                >
                  Retry
                </button>
              </div>
            )}
            <div className="cedar-context-messages">
              {messages.map((m) => {
                const isPinPoint =
                  activeConversation?.pinnedSummary?.pinnedAtMessageId === m.id;
                const preview =
                  contentBlocksToPlainText(m.content).slice(0, 25) || "(empty)";
                return (
                  <div
                    key={m.id}
                    className={`cedar-context-msg-item ${isPinPoint ? "cedar-context-msg-pinned" : ""}`}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isPinPoint}
                      aria-label={
                        isPinPoint
                          ? "Unpin message summary"
                          : "Pin from this message"
                      }
                      className={`cedar-context-pin-btn ${
                        isPinPoint ? "cedar-context-pin-btn-checked" : ""
                      }`}
                      onClick={() => handlePinMessage(m.id)}
                      disabled={busy}
                      title={
                        isPinPoint
                          ? "Unpin message summary"
                          : "Pin: summarize everything above"
                      }
                    >
                      <span className="cedar-context-pin-mark" aria-hidden="true" />
                    </button>
                    <span className="cedar-context-msg-role">
                      {m.role === "user" ? "U" : "A"}
                    </span>
                    <button
                      type="button"
                      className="cedar-context-msg-btn"
                      onClick={() => {
                        const el = document.getElementById(`msg-${m.id}`);
                        el?.scrollIntoView({
                          behavior: isMobileStreamDevice() ? "auto" : "smooth",
                          block: "center",
                        });
                      }}
                      title={preview}
                    >
                      <span className="cedar-context-msg-text">{preview}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </aside>

      {/* Settings 抽屉 */}
      <Settings
        open={settingsOpen}
        activeTab={settingsTab}
        providers={providers}
        preferences={preferences}
        mcpServers={mcpServers}
        ttsSettings={ttsSettings}
        syncSettings={syncSettings}
        syncBusy={syncBusy}
        syncStatus={syncStatus}
        onClose={() => setSettingsOpen(false)}
        onChange={setProviders}
        onActiveTabChange={setSettingsTab}
        onPreferencesChange={setPreferences}
        onMcpServersChange={setMcpServers}
        onTtsSettingsChange={setTtsSettings}
        onSyncSettingsChange={setSyncSettings}
        onSyncPush={handleSyncPush}
        onSyncPull={handleSyncPull}
        userStyle={userStyle}
        userStyleSettings={userStyleSettings}
        onUserStyleSettingsChange={handleUserStyleSettingsChange}
      />
      <ExportDialog
        open={exportOpen}
        conversations={conversations}
        selectedIds={exportSelectedIds}
        onClose={() => setExportOpen(false)}
        onToggle={toggleExportConversation}
        onSelectAll={() => setExportSelectedIds(conversations.map((c) => c.id))}
        onSelectNone={() => setExportSelectedIds([])}
        onExport={handleExportSelected}
      />
      <WindowSettingsDialog
        open={windowSettingsOpen}
        conversation={activeConversation}
        providers={providers}
        currentProvider={currentProvider}
        selectedModel={selectedModel}
        capability={capability}
        claudeCacheAvailable={claudeCacheAvailable}
        agentCacheEstimate={agentCacheEstimate}
        agentCacheMinimum={agentCacheMinimum}
        ttsEnabled={ttsVoiceMessagesAvailable}
        onClose={() => setWindowSettingsOpen(false)}
        onChange={handleWindowSettingsChange}
      />
      <AgentDialog
        open={agentsOpen}
        agents={agents}
        activeAgentId={activeAgent?.id ?? null}
        onClose={() => setAgentsOpen(false)}
        onChange={handleAgentsChange}
        onSelect={selectAgent}
      />
    </div>
  );
}

function ExportDialog({
  open,
  conversations,
  selectedIds,
  onClose,
  onToggle,
  onSelectAll,
  onSelectNone,
  onExport,
}: {
  open: boolean;
  conversations: Conversation[];
  selectedIds: string[];
  onClose: () => void;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onExport: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <section className="relative w-full max-w-lg rounded bg-white shadow-xl dark:bg-neutral-900">
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-base font-semibold">Export chats</h2>
          <button
            onClick={onClose}
            className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Close
          </button>
        </header>

        <div className="p-5">
          <div className="mb-3 flex items-center justify-between text-sm">
            <span className="text-neutral-500">
              {selectedIds.length} of {conversations.length} selected
            </span>
            <div className="flex gap-2">
              <button
                onClick={onSelectAll}
                className="rounded px-2 py-1 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950"
              >
                All
              </button>
              <button
                onClick={onSelectNone}
                className="rounded px-2 py-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                None
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-800">
            {conversations.map((conversation) => (
              <label
                key={conversation.id}
                className="flex cursor-pointer items-start gap-3 border-b border-neutral-100 px-3 py-2 last:border-b-0 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/60"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(conversation.id)}
                  onChange={() => onToggle(conversation.id)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {conversation.title}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {conversation.messages.length} messages
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <footer className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <button
            onClick={onClose}
            className="rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={onExport}
            disabled={selectedIds.length === 0}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Export
          </button>
        </footer>
      </section>
    </div>
  );
}

function WindowSettingsDialog({
  open,
  conversation,
  providers,
  currentProvider,
  selectedModel,
  capability,
  claudeCacheAvailable,
  agentCacheEstimate,
  agentCacheMinimum,
  ttsEnabled,
  onClose,
  onChange,
}: {
  open: boolean;
  conversation: Conversation | null;
  providers: ProviderConfig[];
  currentProvider: ProviderConfig | null;
  selectedModel: string | null;
  capability: ModelCapability | null;
  claudeCacheAvailable: boolean;
  agentCacheEstimate: number;
  agentCacheMinimum: number | null;
  ttsEnabled: boolean;
  onClose: () => void;
  onChange: (patch: WindowSettingsPatch) => void;
}) {
  if (!open || !conversation) return null;

  const showEffort =
    capability?.thinkingEffort &&
    (!capability.thinkingBudget || conversation.thinkingMode === "effort");
  const showBudget =
    capability?.thinkingBudget &&
    (!capability.thinkingEffort || conversation.thinkingMode === "budget");

  function changeProvider(providerId: string) {
    const provider = providers.find((item) => item.id === providerId) ?? null;
    onChange({
      providerId: provider?.id ?? null,
      model: provider?.models[0] ?? null,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <section className="relative flex max-h-[90dvh] w-full max-w-2xl flex-col rounded bg-white shadow-xl dark:bg-neutral-900 sm:max-h-[82vh]">
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
          <h2 className="text-base font-semibold">窗口设置</h2>
          <button
            onClick={onClose}
            className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Close
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Model
            </h3>
            <label className="block text-sm">
              <span className="mb-1 block text-neutral-500">Provider</span>
              <select
                className="select w-full"
                value={conversation.providerId ?? ""}
                onChange={(event) => changeProvider(event.target.value)}
              >
                <option value="">Select provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-neutral-500">Model</span>
              <select
                className="select w-full"
                value={selectedModel ?? ""}
                onChange={(event) =>
                  onChange({ model: event.target.value || null })
                }
                disabled={!currentProvider}
              >
                <option value="">Select model</option>
                {currentProvider?.models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Generation
            </h3>

            {capability?.supportsSampling && (
              <label className="block text-sm">
                <span className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-neutral-500">Temperature</span>
                  <span className="font-mono text-neutral-500">
                    {conversation.temperature.toFixed(1)}
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  value={conversation.temperature}
                  onChange={(event) =>
                    onChange({
                      temperature: normalizeTemperature(
                        parseFloat(event.target.value),
                      ),
                    })
                  }
                  className="w-full"
                />
              </label>
            )}

            {capability?.isReasoning && (
              <div className="space-y-3">
                <label className="flex items-center justify-between gap-4 text-sm">
                  <span className="font-medium">Thinking</span>
                  <input
                    type="checkbox"
                    checked={conversation.reasoningEnabled}
                    onChange={(event) =>
                      onChange({ reasoningEnabled: event.target.checked })
                    }
                  />
                </label>

                {conversation.reasoningEnabled &&
                  capability.thinkingEffort &&
                  capability.thinkingBudget && (
                    <label className="block text-sm">
                      <span className="mb-1 block text-neutral-500">
                        Thinking control
                      </span>
                      <select
                        className="select w-full"
                        value={conversation.thinkingMode}
                        onChange={(event) =>
                          onChange({
                            thinkingMode: event.target.value as ThinkingMode,
                          })
                        }
                      >
                        <option value="effort">By effort</option>
                        <option value="budget">By budget</option>
                      </select>
                    </label>
                  )}

                {conversation.reasoningEnabled && showEffort && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-neutral-500">
                      Effort
                    </span>
                    <select
                      className="select w-full"
                      value={conversation.thinkingEffort}
                      onChange={(event) =>
                        onChange({
                          thinkingEffort: event.target.value as ThinkingEffort,
                        })
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                )}

                {conversation.reasoningEnabled && showBudget && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-neutral-500">
                      Thinking tokens
                    </span>
                    <input
                      type="number"
                      min={1024}
                      max={64000}
                      step={1024}
                      value={conversation.thinkingBudgetTokens}
                      onChange={(event) =>
                        onChange({
                          thinkingBudgetTokens: normalizeThinkingBudgetTokens(
                            parseInt(event.target.value),
                          ),
                        })
                      }
                      className="input"
                    />
                  </label>
                )}
              </div>
            )}

            {!capability?.supportsSampling && !capability?.isReasoning && (
              <div className="text-sm text-neutral-500">No extra controls</div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Chat
            </h3>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium">AI 连发消息</span>
              <input
                type="checkbox"
                checked={conversation.multiMessageEnabled}
                onChange={(event) =>
                  onChange({ multiMessageEnabled: event.target.checked })
                }
              />
            </label>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Voice messages
            </h3>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium">Allow AI voice messages</span>
              <input
                type="checkbox"
                checked={conversation.voiceMessagesEnabled}
                onChange={(event) =>
                  onChange({ voiceMessagesEnabled: event.target.checked })
                }
              />
            </label>

            {conversation.voiceMessagesEnabled && (
              <label className="block text-sm">
                <span className="mb-1 block text-neutral-500">
                  Voice budget tokens
                </span>
                <input
                  type="number"
                  min={0}
                  max={4000}
                  step={20}
                  value={conversation.voiceMessageBudgetTokens}
                  onChange={(event) =>
                    onChange({
                      voiceMessageBudgetTokens: normalizeVoiceMessageBudgetTokens(
                        parseInt(event.target.value),
                      ),
                    })
                  }
                  className="input"
                />
              </label>
            )}

            {conversation.voiceMessagesEnabled && !ttsEnabled && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                Select an audio-synthesis TTS profile in Providers → 语音 before
                the AI can send playable voice messages.
              </div>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              Prompt cache
            </h3>

            <label className="block text-sm">
              <span className="mb-1 block text-neutral-500">
                Agent cache
              </span>
              <select
                className="select w-full"
                value={conversation.agentPromptCache}
                onChange={(event) =>
                  onChange({
                    agentPromptCache:
                      event.target.value as ClaudePromptCacheTTL,
                  })
                }
                disabled={!claudeCacheAvailable}
              >
                <option value="off">Off</option>
                <option value="5m">5m</option>
                <option value="1h">1h</option>
              </select>
            </label>

            {claudeCacheAvailable &&
              conversation.agentPromptCache !== "off" &&
              agentCacheMinimum && (
                <div
                  className={`text-xs ${
                    agentCacheEstimate >= agentCacheMinimum
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
                  }`}
                >
                  fixed ≈ {agentCacheEstimate}/{agentCacheMinimum} tokens
                </div>
              )}

            <label className="block text-sm">
              <span className="mb-1 block text-neutral-500">
                Context cache
              </span>
              <select
                className="select w-full"
                value={conversation.contextPromptCache}
                onChange={(event) =>
                  onChange({
                    contextPromptCache:
                      event.target.value as ClaudePromptCacheTTL,
                  })
                }
                disabled={!claudeCacheAvailable}
              >
                <option value="off">Off</option>
                <option value="5m">5m</option>
                <option value="1h">1h</option>
              </select>
            </label>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium">Show message time</span>
              <input
                type="checkbox"
                checked={conversation.showMessageTimestamps}
                onChange={(event) =>
                  onChange({ showMessageTimestamps: event.target.checked })
                }
              />
            </label>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium">Inject current time</span>
              <input
                type="checkbox"
                checked={conversation.injectCurrentTime}
                onChange={(event) =>
                  onChange({ injectCurrentTime: event.target.checked })
                }
              />
            </label>
          </section>
        </div>
      </section>
    </div>
  );
}

function blankAgent(): Agent {
  const now = Date.now();
  return {
    id: newAgentId(),
    name: "New agent",
    profile: "",
    memory: "",
    instructions: "",
    worldBook: "",
    createdAt: now,
    updatedAt: now,
  };
}

function AgentDialog({
  open,
  agents,
  activeAgentId,
  onClose,
  onChange,
  onSelect,
}: {
  open: boolean;
  agents: Agent[];
  activeAgentId: string | null;
  onClose: () => void;
  onChange: (agents: Agent[]) => void;
  onSelect: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(activeAgentId);
  const editingAgent =
    agents.find((agent) => agent.id === editingId) ??
    agents.find((agent) => agent.id === activeAgentId) ??
    agents[0] ??
    null;

  if (!open) return null;

  function updateAgent(patch: Partial<Agent>) {
    if (!editingAgent) return;
    onChange(
      agents.map((agent) =>
        agent.id === editingAgent.id
          ? { ...agent, ...patch, updatedAt: Date.now() }
          : agent,
      ),
    );
  }

  function createAgent() {
    const agent = blankAgent();
    onChange([agent, ...agents]);
    setEditingId(agent.id);
    onSelect(agent.id);
  }

  function deleteAgent() {
    if (!editingAgent) return;
    if (agents.length <= 1) {
      alert("Keep at least one agent.");
      return;
    }
    if (!confirm("Delete this agent? Its chats will move to another agent.")) {
      return;
    }

    const next = agents.filter((agent) => agent.id !== editingAgent.id);
    const nextActive = next[0];
    onChange(next);
    setEditingId(nextActive.id);
    onSelect(nextActive.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 sm:px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <section className="relative flex h-[90dvh] w-full max-w-5xl flex-col rounded bg-white shadow-xl dark:bg-neutral-900 sm:h-[80vh] sm:flex-row">
        <aside className="max-h-52 w-full shrink-0 overflow-y-auto border-b border-neutral-200 dark:border-neutral-800 sm:max-h-none sm:w-64 sm:border-b-0 sm:border-r">
          <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
            <button
              onClick={createAgent}
              className="w-full rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              + New agent
            </button>
          </div>
          <nav className="max-h-full overflow-y-auto p-2">
            {agents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => setEditingId(agent.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm ${
                  agent.id === editingAgent?.id
                    ? "bg-neutral-100 dark:bg-neutral-800"
                    : "hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                }`}
              >
                <span className="block truncate font-medium">{agent.name}</span>
                {agent.id === activeAgentId && (
                  <span className="text-xs text-blue-600 dark:text-blue-400">
                    active
                  </span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3 dark:border-neutral-800">
            <h2 className="text-base font-semibold">Agents</h2>
            <button
              onClick={onClose}
              className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Close
            </button>
          </header>

          {editingAgent && (
            <div className="flex-1 overflow-y-auto p-5">
              <div className="max-w-3xl space-y-5">
                <label className="block">
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Name
                  </span>
                  <input
                    className="input mt-1"
                    value={editingAgent.name}
                    onChange={(event) =>
                      updateAgent({ name: event.target.value || "Untitled" })
                    }
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Profile
                  </span>
                  <textarea
                    className="input mt-1 min-h-40 resize-y"
                    value={editingAgent.profile}
                    onChange={(event) =>
                      updateAgent({ profile: event.target.value })
                    }
                    placeholder="Stable identity, speaking style, role, boundaries..."
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Memory
                  </span>
                  <textarea
                    className="input mt-1 min-h-56 resize-y"
                    value={editingAgent.memory}
                    onChange={(event) =>
                      updateAgent({ memory: event.target.value })
                    }
                    placeholder="Long-term facts, user preferences, stable background..."
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Instruction Injection
                  </span>
                  <textarea
                    className="input mt-1 min-h-40 resize-y"
                    value={editingAgent.instructions}
                    onChange={(event) =>
                      updateAgent({ instructions: event.target.value })
                    }
                    placeholder="Fixed per-agent instructions that should stay before chat history..."
                  />
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    Fixed World Book
                  </span>
                  <textarea
                    className="input mt-1 min-h-56 resize-y"
                    value={editingAgent.worldBook}
                    onChange={(event) =>
                      updateAgent({ worldBook: event.target.value })
                    }
                    placeholder="Stable world lore, character facts, rules, setting notes..."
                  />
                </label>

                <div className="flex gap-2">
                  <button
                    onClick={() => onSelect(editingAgent.id)}
                    className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
                  >
                    Use agent
                  </button>
                  <button
                    onClick={deleteAgent}
                    className="ml-auto rounded px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="flex max-w-full items-center gap-2 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
      <span className="min-w-0 truncate">
        {attachment.name} · {formatBytes(attachment.size)}
      </span>
      {attachment.error && (
        <span className="shrink-0 text-amber-600 dark:text-amber-400">
          limited
        </span>
      )}
      <button
        onClick={onRemove}
        className="shrink-0 rounded px-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
        title="Remove attachment"
      >
        ×
      </button>
    </div>
  );
}

function AttachmentPreview({
  attachment,
  compact,
}: {
  attachment: ChatAttachment;
  compact?: boolean;
}) {
  return (
    <div
      className={`mb-2 overflow-hidden rounded border text-left ${
        compact
          ? "border-blue-300 bg-white text-neutral-900"
          : "border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
    >
      {attachment.kind === "image" && attachment.dataUrl && (
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="max-h-64 w-full object-contain bg-black/5"
        />
      )}
      <div className="px-3 py-2">
        <div className="truncate text-sm font-medium">{attachment.name}</div>
        <div
          className={`text-xs ${
            compact ? "text-neutral-500" : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
          {attachment.kind} · {formatBytes(attachment.size)}
        </div>
        {attachment.error && (
          <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
            {attachment.error}
          </div>
        )}
      </div>
    </div>
  );
}

function VoiceMessageView({
  block,
  autoPlay = false,
  onGenerate,
  onLoad,
  onAutoPlayAttempted,
}: {
  block: VoiceBlock;
  autoPlay?: boolean;
  onGenerate?: (voiceBlockId: string) => void;
  onLoad?: (voiceBlockId: string) => void;
  onAutoPlayAttempted?: (voiceBlockId: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const autoPlayAttemptedRef = useRef(false);

  useEffect(() => {
    if (
      !autoPlay ||
      autoPlayAttemptedRef.current ||
      block.status !== "ready" ||
      !block.audioUrl
    ) {
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;

    autoPlayAttemptedRef.current = true;
    audio.play().catch(() => undefined);
    onAutoPlayAttempted?.(block.id);
  }, [autoPlay, block.audioUrl, block.id, block.status, onAutoPlayAttempted]);

  return (
    <div className="cedar-voice-message">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="cedar-voice-label">
          语音消息
        </span>
        {block.status === "pending" && (
          <span className="cedar-voice-status">
            生成中...
          </span>
        )}
        {block.status !== "pending" && !block.audioUrl && (
          <button
            type="button"
            onClick={() =>
              block.audioRef ? onLoad?.(block.id) : onGenerate?.(block.id)
            }
            className="cedar-voice-button"
          >
            {block.audioRef
              ? block.status === "error"
                ? "重新载入"
                : "载入语音"
              : block.status === "error"
                ? "重试"
                : "生成语音"}
          </button>
        )}
      </div>
      {block.audioUrl && (
        <audio
          ref={audioRef}
          controls
          src={block.audioUrl}
          className="mb-2 w-full"
        />
      )}
      {block.status === "error" && (
        <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {block.error ?? "Voice synthesis failed."}
        </div>
      )}
      <div className="whitespace-pre-wrap text-sm leading-6">{block.text}</div>
    </div>
  );
}

function ThinkingBlockView({
  text,
  streaming,
  summary,
  summaryStatus,
  summaryError,
}: {
  text: string;
  streaming?: boolean;
  summary?: string;
  summaryStatus?: "pending" | "done" | "error";
  summaryError?: string;
}) {
  return (
    <ThinkingBlockDetails
      key={streaming ? "streaming" : "settled"}
      text={text}
      initialOpen={Boolean(streaming)}
      summary={summary}
      summaryStatus={summaryStatus}
      summaryError={summaryError}
    />
  );
}

function ThinkingBlockDetails({
  text,
  initialOpen,
  summary,
  summaryStatus,
  summaryError,
}: {
  text: string;
  initialOpen: boolean;
  summary?: string;
  summaryStatus?: "pending" | "done" | "error";
  summaryError?: string;
}) {
  const [open, setOpen] = useState(initialOpen);

  // 摘要在 details 折叠时也能看到 → 当作 summary 行渲染
  const summaryLabel = (() => {
    if (summary && summaryStatus === "done") return summary;
    if (summaryStatus === "pending") return "summarizing…";
    if (summaryStatus === "error") return "summary failed";
    return "thinking";
  })();

  return (
    <details
      className="cedar-thinking-block mb-2 text-neutral-500 dark:text-neutral-400 border-l-2 border-neutral-300 dark:border-neutral-600 pl-3"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-summary-status={summaryStatus ?? "none"}
    >
      <summary className="cedar-thinking-summary cursor-pointer select-none text-sm">
        <span className="cedar-thinking-label">thinking</span>
        <span className="cedar-thinking-headline">{summaryLabel}</span>
      </summary>
      <div className="cedar-thinking-body whitespace-pre-wrap mt-1">{text}</div>
      {summaryStatus === "error" && summaryError && (
        <div className="cedar-thinking-summary-error text-xs mt-1 opacity-70">
          summary error: {summaryError}
        </div>
      )}
    </details>
  );
}

function ToolBlockView({ block }: { block: ToolBlock }) {
  const statusLabel =
    block.status === "pending"
      ? "running"
      : block.status === "success"
        ? "done"
        : "failed";
  const statusClass =
    block.status === "pending"
      ? "text-amber-600 dark:text-amber-300"
      : block.status === "success"
        ? "text-emerald-600 dark:text-emerald-300"
        : "text-red-600 dark:text-red-300";

  return (
    <details
      className="my-2 rounded border border-neutral-200 bg-neutral-50 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      open={block.status !== "success"}
    >
      <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-3 py-2 text-sm">
        <span className="min-w-0 truncate font-medium">Tool · {block.name}</span>
        <span className={`shrink-0 text-xs ${statusClass}`}>{statusLabel}</span>
      </summary>
      <div className="space-y-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-700">
        {block.input && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase text-neutral-400">
              Input
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs leading-5 text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
              {block.input}
            </pre>
          </div>
        )}
        {block.output && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase text-neutral-400">
              Output
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs leading-5 text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
              {block.output}
            </pre>
          </div>
        )}
        {block.error && (
          <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {block.error}
          </div>
        )}
      </div>
    </details>
  );
}

// ------------------------- Copy button component -------------------------

function CopyButton({ content }: { content: ContentBlock[] }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = contentBlocksToPlainText(content, true);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers / insecure contexts
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="cedar-action-button"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ------------------------- Message component -------------------------

interface MessageRenderBoundaryProps {
  resetKey: string;
  content: ContentBlock[];
  children: ReactNode;
}

interface MessageRenderBoundaryState {
  hasError: boolean;
}

class MessageRenderBoundary extends Component<
  MessageRenderBoundaryProps,
  MessageRenderBoundaryState
> {
  state: MessageRenderBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MessageRenderBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn("Could not render message content.", error, info.componentStack);
  }

  componentDidUpdate(previousProps: MessageRenderBoundaryProps) {
    if (
      this.state.hasError &&
      previousProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const fallbackText =
      contentBlocksToPlainText(this.props.content, true).trim() ||
      "This message could not be rendered.";

    return (
      <pre className="cedar-render-fallback">
        {fallbackText}
      </pre>
    );
  }
}

function contentBlockRenderSignature(block: ContentBlock): string {
  if (block.type === "text" || block.type === "thinking") {
    return `${block.type}:${block.text.length}`;
  }
  if (block.type === "attachment") {
    return `attachment:${block.attachment.id}:${block.attachment.size}`;
  }
  if (block.type === "voice") {
    return `voice:${block.id}:${block.status ?? "text"}:${block.text.length}`;
  }
  return `tool:${block.id}:${block.status}:${block.input?.length ?? 0}:${
    block.output?.length ?? 0
  }:${block.error?.length ?? 0}`;
}

function messageRenderResetKey(message: UIMessage): string {
  return `${message.id}:${activeAssistantAlternativeIndex(message)}:${
    message.streaming ? "streaming" : "settled"
  }:${message.content
    .map(contentBlockRenderSignature)
    .join("|")}`;
}

interface MessageViewProps {
  message: UIMessage;
  busy: boolean;
  canChat: boolean;
  assistantName: string;
  modelName: string | null;
  isEditing: boolean;
  editingText: string;
  isLastAssistant: boolean;
  alternativeIndex: number;
  alternativeCount: number;
  canSpeak: boolean;
  speaking: boolean;
  autoPlayVoiceBlockIds: ReadonlySet<string>;
  onEditingTextChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRegenerate: () => void;
  onAlternativeChange: (direction: -1 | 1) => void;
  onContinue: () => void;
  onSpeak: () => void;
  onGenerateVoiceBlock: (voiceBlockId: string) => void;
  onLoadVoiceBlock: (voiceBlockId: string) => void;
  onVoiceAutoPlayAttempted: (voiceBlockId: string) => void;
}

function MessageView({
  message,
  busy,
  canChat,
  assistantName,
  modelName,
  isEditing,
  editingText,
  isLastAssistant,
  alternativeIndex,
  alternativeCount,
  canSpeak,
  speaking,
  autoPlayVoiceBlockIds,
  onEditingTextChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRegenerate,
  onAlternativeChange,
  onContinue,
  onSpeak,
  onGenerateVoiceBlock,
  onLoadVoiceBlock,
  onVoiceAutoPlayAttempted,
}: MessageViewProps) {
  const isUser = message.role === "user";
  const timestampLabel = formatMessageTimestamp(message.createdAt);
  const authorLabel = isUser ? "You" : assistantName;
  const costEstimate =
    message.usage && !message.streaming
      ? estimateMessageCost(modelName, message.usage)
      : null;
  return (
    <article
      id={`msg-${message.id}`}
      className={`group cedar-message ${
        isUser ? "message-flora" : "message-cedar"
      } ${message.streaming && !isUser ? "cedar-thinking" : ""}`}
    >
      <div className="message-meta">
        <span>{authorLabel}</span>
        {!isUser && modelName && <span> · {modelName}</span>}
        {timestampLabel && <span> · {timestampLabel}</span>}
      </div>
      <div
        className={`cedar-message-body ${
          message.streaming && !isUser ? "cedar-streaming-text" : ""
        }`}
      >
        {isEditing ? (
          <div className="cedar-edit-box">
            <textarea
              className="input min-h-24 resize-y"
              value={editingText}
              onChange={(e) => onEditingTextChange(e.target.value)}
              autoFocus
            />
            <div className="cedar-edit-actions">
              <button
                onClick={onCancelEdit}
                className="cedar-ghost-button"
              >
                Cancel
              </button>
              <button
                onClick={onSaveEdit}
                disabled={!canChat || !editingText.trim()}
                className="cedar-send-button"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <MessageRenderBoundary
            resetKey={messageRenderResetKey(message)}
            content={message.content}
          >
            {message.content.length === 0 && (message.streaming || !isUser) && (
              <span className="text-neutral-400 italic">...</span>
            )}
            {message.content.map((block, i) =>
              block.type === "thinking" ? (
                <ThinkingBlockView
                  key={i}
                  text={block.text}
                  streaming={message.streaming}
                  summary={block.summary}
                  summaryStatus={block.summaryStatus}
                  summaryError={block.summaryError}
                />
              ) : block.type === "attachment" ? (
                <AttachmentPreview
                  key={i}
                  attachment={block.attachment}
                  compact={isUser}
                />
              ) : block.type === "voice" ? (
                <VoiceMessageView
                  key={block.id}
                  block={block}
                  autoPlay={autoPlayVoiceBlockIds.has(block.id)}
                  onGenerate={onGenerateVoiceBlock}
                  onLoad={onLoadVoiceBlock}
                  onAutoPlayAttempted={onVoiceAutoPlayAttempted}
                />
              ) : block.type === "tool" ? (
                <ToolBlockView key={block.id} block={block} />
              ) : (
                <MarkdownText
                  key={i}
                  text={block.text}
                  disableArtifacts={Boolean(message.streaming)}
                  plainText={Boolean(
                    message.streaming &&
                      block.text.length >= STREAMING_PLAIN_TEXT_CHARS,
                  )}
                />
              ),
            )}
          </MessageRenderBoundary>
        )}
        {message.usage && !message.streaming && (
          <div className="cedar-usage-line">
            {costEstimate && (
              <>
                <span title={costEstimate.title}>
                  cost: {costEstimate.label}
                </span>{" "}
                ·{" "}
              </>
            )}
            in: {message.usage.inputTokens} · out: {message.usage.outputTokens}
            {message.usage.cachedInputTokens !== undefined && (
              <> · cached: {message.usage.cachedInputTokens}</>
            )}
            {message.usage.cacheWriteInputTokens !== undefined && (
              <> · cache write: {message.usage.cacheWriteInputTokens}</>
            )}
          </div>
        )}
      </div>
      {!isEditing && (
        <div className="cedar-message-actions">
          {isUser ? (
            <button
              onClick={onStartEdit}
              disabled={busy || !canChat}
              className="cedar-action-button"
            >
              Edit
            </button>
	          ) : (
	            <>
	              {alternativeCount > 1 && (
	                <div className="cedar-version-switcher" aria-label="Reply versions">
	                  <button
	                    type="button"
	                    onClick={() => onAlternativeChange(-1)}
	                    disabled={busy || alternativeIndex <= 0}
	                    className="cedar-action-button"
	                    aria-label="Previous reply version"
	                  >
	                    ‹
	                  </button>
	                  <span>
	                    {alternativeIndex + 1}/{alternativeCount}
	                  </span>
	                  <button
	                    type="button"
	                    onClick={() => onAlternativeChange(1)}
	                    disabled={busy || alternativeIndex >= alternativeCount - 1}
	                    className="cedar-action-button"
	                    aria-label="Next reply version"
	                  >
	                    ›
	                  </button>
	                </div>
	              )}
	              <button
	                onClick={onRegenerate}
	                disabled={busy || !canChat}
                className="cedar-action-button"
              >
                Regenerate
              </button>
              {isLastAssistant && (
                <button
                  onClick={onContinue}
                  disabled={busy || !canChat}
                  className="cedar-action-button"
                >
                  Continue
                </button>
              )}
              {canSpeak && (
                <button
                  onClick={onSpeak}
                  disabled={busy && !speaking}
                  className="cedar-action-button"
                >
                  {speaking ? "停止语音" : "语音"}
                </button>
              )}
                <CopyButton content={message.content} />
            </>
          )}
        </div>
      )}
    </article>
  );
}
