// 所有 Provider 共享的类型定义
// 设计原则：
// - 请求参数都放在 ChatRequest 里，Provider 自己决定传哪些
// - 响应统一成 ContentBlock[]，UI 不用知道底下是哪家 API
// - ModelCapability 表描述每个模型支持什么，Provider 和 UI 共享

// ------------------------- Messages -------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type CacheTTL = "5m" | "1h";

export interface ChatTextContentPart {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
    ttl?: CacheTTL;
  };
}

export interface ChatImageContentPart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export type ChatContentPart = ChatTextContentPart | ChatImageContentPart;

export interface ChatMessage {
  role: ChatRole;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

// ------------------------- Request -------------------------

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
  systemContent?: ChatTextContentPart[];
  promptCache?: {
    type: "ephemeral";
    ttl?: CacheTTL;
  };
  maxTokens?: number;

  // Sampling 参数 - 只有非推理模型接受
  temperature?: number;
  topP?: number;

  // 推理控制 - 只有推理模型接受
  // effort 和 budgetTokens 可以同时设置（OpenRouter 给 Anthropic 时两个都吃）
  reasoning?: {
    enabled: boolean;
    effort?: "low" | "medium" | "high";
    budgetTokens?: number;
  };

  // Anthropic 专属
  cacheSystemPrompt?: boolean;

  tools?: ChatTool[];
  toolChoice?: "auto" | "none";

  signal?: AbortSignal;
}

// ------------------------- Response -------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  signature?: string; // Anthropic 多轮 thinking 需要回传
  // 由前端"thinking summary"功能生成,不参与上游请求,仅用于 UI 展示
  summary?: string;
  summaryStatus?: "pending" | "done" | "error";
  summaryError?: string;
}

export type AttachmentKind =
  | "image"
  | "text"
  | "code"
  | "notebook"
  | "pdf"
  | "other";

export interface ChatAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: AttachmentKind;
  text?: string;
  dataUrl?: string;
  error?: string;
  file?: File;
}

export interface AttachmentBlock {
  type: "attachment";
  attachment: ChatAttachment;
}

export interface VoiceBlock {
  type: "voice";
  id: string;
  text: string;
  audioUrl?: string;
  audioRef?: {
    id: string;
    mime: string;
    size: number;
    createdAt?: string;
  };
  status?: "pending" | "ready" | "error";
  error?: string;
}

export interface ToolBlock {
  type: "tool";
  id: string;
  name: string;
  status: "pending" | "success" | "error";
  input?: string;
  output?: string;
  error?: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | AttachmentBlock
  | VoiceBlock
  | ToolBlock;

export interface ChatResponse {
  id: string;
  model: string;
  content: ContentBlock[];
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}

export interface ChatStreamChunk {
  kind: "text" | "thinking" | "tool_calls";
  delta: string;
  done: boolean;
  finishReason?: string;
  toolCalls?: ChatToolCall[];
  signature?: string;
  // OpenRouter / OpenAI 在流的最后一个 SSE 事件里带 usage
  // Provider 捕获到就顺便在 chunk 上吐出来，UI 就能显示
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}

// ------------------------- Capability -------------------------

export interface ModelCapability {
  // 是否是推理模型
  isReasoning: boolean;
  // 是否接受 sampling 参数（temperature / top_p）
  supportsSampling: boolean;
  // 是否支持 streaming
  supportsStreaming: boolean;
  // 是否支持 prompt caching（目前只有 Anthropic 原生）
  supportsCaching: boolean;
  // 思考控制 - 两个独立 flag，模型可能支持其一、两个都支持、或都不支持
  // - thinkingEffort: 接受 "low"/"medium"/"high" 档位
  // - thinkingBudget: 接受具体 token 数
  thinkingEffort: boolean;
  thinkingBudget: boolean;
}

// ------------------------- Provider -------------------------

export interface ChatProvider {
  readonly name: string;
  readonly baseUrl: string;

  getModelCapability(modelId: string): ModelCapability;

  sendMessage(request: ChatRequest): Promise<ChatResponse>;
  streamMessage(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
}

// ------------------------- Provider config (user-facing) -------------------------
// 用户在 UI 上填的东西，存 localStorage 用

export type ProviderKind = "openai-compatible" | "anthropic";

export interface ProviderConfig {
  id: string;            // 内部 id（生成）
  name: string;          // 用户起的名字，如 "OpenRouter" / "某中转"
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  // 用户常用的模型 ID 列表，第一项是默认
  models: string[];
}
