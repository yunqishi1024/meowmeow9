// OpenAI-compatible Provider
//
// 覆盖 OpenAI 官方、OpenRouter、DeepSeek、各种中转站、自建 vLLM 等
// 所有能说 /chat/completions 的都走这里。
//
// Provider 内部根据 capability 表自动裁剪请求字段：
// - 模型不支持 temperature → 悄悄去掉，不抛错
// - 模型是推理模型 → 用 reasoning_effort 而不是 temperature
// - DeepSeek R1 的 reasoning_content 字段 → 转成 ContentBlock 的 thinking 块

import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ChatToolCall,
  ContentBlock,
  ModelCapability,
} from "./types";
import { getCapability } from "./capabilities";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): ChatToolCall | null => {
      const record = asRecord(item);
      const fn = asRecord(record.function);
      const name = asString(fn.name) ?? asString(record.name);
      if (!name) return null;
      return {
        id: asString(record.id) ?? `call_${index}`,
        type: "function",
        function: {
          name,
          arguments:
            asString(fn.arguments) ??
            asString(record.arguments) ??
            stringifyToolArguments(record.input),
        },
      };
    })
    .filter((item): item is ChatToolCall => item !== null);
}

function stringifyToolArguments(value: unknown): string {
  if (value === undefined) return "{}";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "{}";
  }
}

function parseToolCallsFromContent(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index): ChatToolCall | null => {
      const record = asRecord(item);
      if (
        record.type !== "tool_use" &&
        record.type !== "tool_call" &&
        record.type !== "function_call"
      ) {
        return null;
      }

      const fn = asRecord(record.function);
      const name = asString(record.name) ?? asString(fn.name);
      if (!name) return null;

      return {
        id: asString(record.id) ?? `call_${index}`,
        type: "function",
        function: {
          name,
          arguments:
            asString(record.arguments) ??
            asString(fn.arguments) ??
            stringifyToolArguments(record.input),
        },
      };
    })
    .filter((item): item is ChatToolCall => item !== null);
}

function appendToolCallDelta(
  parts: Map<number, { id?: string; name?: string; arguments: string }>,
  value: unknown,
) {
  const values = Array.isArray(value)
    ? value
    : Object.keys(asRecord(value)).length > 0
      ? [value]
      : [];
  if (values.length === 0) return;

  values.forEach((item, fallbackIndex) => {
    const record = asRecord(item);
    const index = asNumber(record.index) ?? fallbackIndex;
    const part = parts.get(index) ?? { arguments: "" };
    const id = asString(record.id);
    if (id) part.id = id;

    const fn = asRecord(record.function);
    const name = asString(fn.name);
    if (name) part.name = `${part.name ?? ""}${name}`;
    const args = asString(fn.arguments);
    if (args) part.arguments += args;

    parts.set(index, part);
  });
}

function appendLegacyFunctionCallDelta(
  parts: Map<number, { id?: string; name?: string; arguments: string }>,
  value: unknown,
) {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return;

  const part = parts.get(0) ?? { arguments: "" };
  const name = asString(record.name);
  if (name) part.name = `${part.name ?? ""}${name}`;
  const args = asString(record.arguments);
  if (args) part.arguments += args;
  parts.set(0, part);
}

function appendContentToolDeltas(
  parts: Map<number, { id?: string; name?: string; arguments: string }>,
  value: unknown,
) {
  if (!Array.isArray(value)) return;

  value.forEach((item, fallbackIndex) => {
    const record = asRecord(item);
    if (
      record.type !== "tool_use" &&
      record.type !== "tool_call" &&
      record.type !== "function_call"
    ) {
      return;
    }

    const index = asNumber(record.index) ?? fallbackIndex;
    const part = parts.get(index) ?? { arguments: "" };
    const id = asString(record.id);
    if (id) part.id = id;

    const fn = asRecord(record.function);
    const name = asString(record.name) ?? asString(fn.name);
    if (name) part.name = `${part.name ?? ""}${name}`;

    const args =
      asString(record.arguments) ??
      asString(fn.arguments) ??
      stringifyToolArguments(record.input);
    if (args !== "{}") part.arguments += args;

    parts.set(index, part);
  });
}

function toolCallPartsToCalls(
  parts: Map<number, { id?: string; name?: string; arguments: string }>,
): ChatToolCall[] {
  return [...parts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, part]): ChatToolCall | null => {
      if (!part.name) return null;
      return {
        id: part.id ?? `call_${index}`,
        type: "function",
        function: {
          name: part.name,
          arguments: part.arguments || "{}",
        },
      };
    })
    .filter((item): item is ChatToolCall => item !== null);
}

function textFromReasoningDetails(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => {
      const detail = asRecord(item);
      return asString(detail.text) ?? asString(detail.summary) ?? "";
    })
    .join("");
}

// 不同厂商在 usage 里放 cached tokens 的字段名不一样，都试一遍
function extractUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
} {
  const u = asRecord(value);
  const promptTokensDetails = asRecord(u.prompt_tokens_details);
  const cached =
    asNumber(promptTokensDetails.cached_tokens) ??
    asNumber(u.cache_read_input_tokens) ??
    asNumber(u.cached_tokens) ??
    undefined;
  const cacheWrite =
    asNumber(promptTokensDetails.cache_write_tokens) ??
    asNumber(promptTokensDetails.cache_creation_tokens) ??
    asNumber(u.cache_creation_input_tokens) ??
    asNumber(u.cache_write_input_tokens) ??
    undefined;
  return {
    inputTokens: asNumber(u.prompt_tokens) ?? asNumber(u.input_tokens) ?? 0,
    outputTokens:
      asNumber(u.completion_tokens) ?? asNumber(u.output_tokens) ?? 0,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
  };
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;
  readonly baseUrl: string;
  protected apiKey: string;

  constructor(name: string, baseUrl: string, apiKey: string) {
    this.name = name;
    // 去掉结尾的 /，避免 base + "/chat/completions" 变成两个 /
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  getModelCapability(modelId: string): ModelCapability {
    return getCapability(modelId);
  }

  // ------------------------- 请求构造 -------------------------

  buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const cap = this.getModelCapability(request.model);

    // system 作为 messages[0] 塞进去。Claude/OpenRouter 缓存需要结构化 content block。
    const systemContent = request.systemContent ?? request.system;
    const messages = systemContent
      ? [{ role: "system", content: systemContent }, ...request.messages]
      : [...request.messages];

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.promptCache) {
      body.cache_control = request.promptCache;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? "auto";
    }

    // Sampling 参数：不支持就悄悄丢掉
    if (cap.supportsSampling) {
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.topP !== undefined) body.top_p = request.topP;
    }

    // 推理控制：兼容多种网关的格式
    // - OpenAI 官方：reasoning_effort: "low" | "medium" | "high"
    // - OpenRouter：reasoning: { effort, max_tokens, exclude: false }
    //   它对 Anthropic 模型默认会过滤 thinking，要显式 exclude:false 才透传
    if (request.reasoning?.enabled && cap.isReasoning) {
      const reasoningPayload: Record<string, unknown> = { exclude: false };

      if (cap.thinkingEffort && request.reasoning.effort) {
        reasoningPayload.effort = request.reasoning.effort;
        // OpenAI 原生协议字段，给走官方 OpenAI endpoint 的情况
        body.reasoning_effort = request.reasoning.effort;
      }

      if (cap.thinkingBudget && request.reasoning.budgetTokens) {
        reasoningPayload.max_tokens = request.reasoning.budgetTokens;
      }

      // 只要模型是 reasoning 的，就传 reasoning 对象（即使 effort/budget 都没给也至少 exclude:false）
      // 这样 OpenRouter 才会把 Anthropic 的 thinking 透传回来
      body.reasoning = reasoningPayload;
    }

    return body;
  }

  // ------------------------- 非流式 -------------------------

  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody(request);

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${this.name} API error ${response.status}: ${text.slice(0, 500)}`,
      );
    }

    const data = await response.json();
    return this.parseResponse(data);
  }

  private parseResponse(data: unknown): ChatResponse {
    const root = asRecord(data);
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const firstChoice = asRecord(choices[0]);
    const message = asRecord(firstChoice.message);
    const content: ContentBlock[] = [];

    // 多种厂商的 thinking 字段名都尝试一遍：
    // - DeepSeek R1：reasoning_content
    // - OpenRouter：reasoning（字符串）或 reasoning_details（数组）
    const thinkingText =
      asString(message.reasoning_content) ??
      asString(message.reasoning) ??
      textFromReasoningDetails(message.reasoning_details);

    if (thinkingText) {
      content.push({ type: "thinking", text: thinkingText });
    }

    const messageContent = asString(message.content);
    if (messageContent) {
      content.push({ type: "text", text: messageContent });
    }

    const toolCalls = [
      ...parseToolCalls(message.tool_calls),
      ...parseToolCallsFromContent(message.content),
    ];

    // 空响应兜底
    if (content.length === 0 && toolCalls.length === 0) {
      content.push({ type: "text", text: "" });
    }

    return {
      id: asString(root.id) ?? "",
      model: asString(root.model) ?? "",
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: asString(firstChoice.finish_reason),
      usage: root.usage ? extractUsage(root.usage) : undefined,
    };
  }

  // ------------------------- 流式 -------------------------

  async *streamMessage(
    request: ChatRequest,
  ): AsyncIterable<ChatStreamChunk> {
    // include_usage: true 让最后一个 SSE 事件里带 usage 统计
    const body = {
      ...this.buildRequestBody(request),
      stream: true,
      stream_options: { include_usage: true },
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${this.name} API error ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    yield* this.streamResponse(response);
  }

  async *streamResponse(
    response: Response,
  ): AsyncIterable<ChatStreamChunk> {
    if (!response.body) throw new Error("No response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let endedCleanly = false;
    let toolCallsEmitted = false;
    const toolCallParts = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // SSE 可能是 \n 或 \r\n，两种都容忍
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") {
            endedCleanly = true;
            const toolCalls = toolCallPartsToCalls(toolCallParts);
            if (toolCalls.length > 0 && !toolCallsEmitted) {
              toolCallsEmitted = true;
              yield {
                kind: "tool_calls",
                delta: "",
                done: false,
                toolCalls,
              };
            }
            yield { kind: "text", delta: "", done: true };
            return;
          }

          try {
            const event = asRecord(JSON.parse(payload) as unknown);

            // Usage 统计一般在最后一个事件里（choices 可能是空数组）
            if (event.usage) {
              yield {
                kind: "text",
                delta: "",
                done: false,
                usage: extractUsage(event.usage),
              };
            }

            const choices = Array.isArray(event.choices) ? event.choices : [];
            const firstChoice = asRecord(choices[0]);
            const finishReason = asString(firstChoice.finish_reason);
            const delta = asRecord(firstChoice.delta);
            if (!delta) continue;

            appendToolCallDelta(toolCallParts, delta.tool_calls);
            appendToolCallDelta(toolCallParts, delta.tool_call);
            appendLegacyFunctionCallDelta(toolCallParts, delta.function_call);
            appendContentToolDeltas(toolCallParts, delta.content);

            // 思考增量：兼容 reasoning_content（DeepSeek）/ reasoning（OpenRouter）/ reasoning_details
            const thinkingDelta =
              asString(delta.reasoning_content) ??
              asString(delta.reasoning) ??
              textFromReasoningDetails(delta.reasoning_details);
            if (thinkingDelta) {
              yield { kind: "thinking", delta: thinkingDelta, done: false };
            }
            const deltaContent = asString(delta.content);
            if (deltaContent) {
              yield { kind: "text", delta: deltaContent, done: false };
            }

            if (
              finishReason === "tool_calls" ||
              finishReason === "tool_use" ||
              finishReason === "function_call"
            ) {
              const toolCalls = toolCallPartsToCalls(toolCallParts);
              if (toolCalls.length > 0 && !toolCallsEmitted) {
                toolCallsEmitted = true;
                yield {
                  kind: "tool_calls",
                  delta: "",
                  done: false,
                  finishReason,
                  toolCalls,
                };
              }
            }
          } catch {
            // 跳过坏事件
          }
        }
      }
    } finally {
      // 即使中途断流也要吐一个 done 让上层解锁
      if (!endedCleanly) {
        yield { kind: "text", delta: "", done: true };
      }
    }
  }
}
