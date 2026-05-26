// 极简 thinking-summary 工具。
//
// 设计原则:
// 1. 超短上下文 —— 只发一条 user 消息,内容就是要总结的 thinking 文本。
//    不带 system、不带历史、不带工具、不带 reasoning 控制,降低 token 消耗。
// 2. 非流式,一次调用一次返回。
// 3. 由 UI 触发,完全与主回复解耦,出错不影响主流程。
//
// 用途:Settings 里开启 "Thinking 自动总结" 后,每段 thinking 流式结束就调用一次,
// 把返回的一句话摘要塞回 ThinkingBlock.summary,显示在 details 顶部。

import {
  createProvider,
  type ChatMessage,
  type ChatRequest,
  type ProviderConfig,
} from "../providers";

export interface SummarizeOptions {
  /** Provider 配置(必须能联通) */
  provider: ProviderConfig;
  /** 用哪个模型跑总结。建议选便宜小模型 */
  model: string;
  /** 要总结的 thinking 原文 */
  thinkingText: string;
  /** 用户偏好语言;不传则跟随 thinking 文本本身 */
  language?: "zh" | "en" | "auto";
  /** 超时(ms),默认 20s */
  timeoutMs?: number;
  /** 外部 abort */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * 截断超长 thinking,避免一次性吞掉太多 token。
 * 实测 Claude / DeepSeek 的 thinking 单段一般不会超 8k tokens ≈ 30k 字符,
 * 但偶尔会出现"反复推演"导致非常长。这里硬截到 12k 字符。
 */
const MAX_THINKING_CHARS = 12_000;

function buildPrompt(thinkingText: string, language: "zh" | "en" | "auto"): string {
  const trimmed =
    thinkingText.length > MAX_THINKING_CHARS
      ? thinkingText.slice(0, MAX_THINKING_CHARS) + "\n…(truncated)"
      : thinkingText;

  const instruction =
    language === "en"
      ? "Summarize the following AI reasoning trace in ONE short English sentence (under 20 words). " +
        "Capture the key insight or conclusion. Do not start with 'The AI' or 'The model'. " +
        "Output the summary directly, no preamble, no markdown."
      : language === "zh"
        ? "用一句话(20 字以内)概括下面 AI 的思考过程,抓住关键结论或转折。" +
          "直接输出,不要任何前缀、引号、标点列表或 markdown。"
        : "Summarize the following reasoning in ONE short sentence (under 20 words), " +
          "in the same language as the input. Capture the key insight or conclusion. " +
          "Output the summary directly, no preamble, no markdown.";

  return `${instruction}\n\n---\n${trimmed}\n---`;
}

/**
 * 跑一次 summary 调用,返回一句话。
 * 失败会抛错,调用方自己 catch。
 */
export async function summarizeThinking(
  options: SummarizeOptions,
): Promise<string> {
  const language = options.language ?? "auto";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const messages: ChatMessage[] = [
    { role: "user", content: buildPrompt(options.thinkingText, language) },
  ];

  const request: ChatRequest = {
    model: options.model,
    messages,
    // 故意不传 system / tools / reasoning,让它就是普通短回复
    // temperature 给 0.2 保证稳定
    temperature: 0.2,
    maxTokens: 120,
  };

  // 组合一个带超时的 AbortSignal
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  request.signal = controller.signal;

  try {
    const provider = createProvider(options.provider);
    const response = await provider.sendMessage(request);

    // 取第一个 text block
    const textBlock = response.content.find((block) => block.type === "text");
    const raw = textBlock && "text" in textBlock ? textBlock.text : "";
    return cleanSummary(raw);
  } finally {
    clearTimeout(timer);
  }
}

/** 去掉常见的多余包装(引号、句号、markdown 列表符号、前缀) */
function cleanSummary(raw: string): string {
  let text = raw.trim();
  // 去 markdown 引用 / 列表
  text = text.replace(/^[>*\-•\s]+/, "");
  // 去包裹引号
  text = text.replace(/^["'`「『](.*)["'`」』]$/s, "$1");
  // 去末尾的句号(中英)
  text = text.replace(/[。．\.]+$/, "");
  // 折叠空白
  text = text.replace(/\s+/g, " ").trim();
  return text;
}
