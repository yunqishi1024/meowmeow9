// 模型能力表 + 带模糊匹配的查询
//
// 模糊匹配能处理这些真实情况：
// - OpenRouter 前缀："anthropic/claude-opus-4-7"
// - 点号 vs 横杠："claude-opus-4.7" / "claude-opus-4-7"
// - 日期/版本后缀："claude-opus-4-7-20260101"
// - 中转站加后缀："gpt-4o@latest"

import type { ModelCapability } from "./types";

// ------------------------- 能力表 -------------------------
//
// thinkingEffort + thinkingBudget 是两个独立 flag：
// - 一些模型只接受 effort 档位（OpenAI o-系列）
// - 一些模型接受 budget tokens（Anthropic 老版 extended thinking）
// - Anthropic 4.x 通过 OpenRouter 两个都接受
// - DeepSeek R1 是推理模型但不暴露任何旋钮

const TABLE: Record<string, ModelCapability> = {
  // ===== Anthropic（通过 OpenRouter 时 effort + budget 都支持）=====
  "claude-opus-4-7": {
    isReasoning: true,
    supportsSampling: false, // Opus 4.7 不接受 temperature / top_p
    supportsStreaming: true,
    supportsCaching: true,
    thinkingEffort: true,
    thinkingBudget: true,
  },
  "claude-opus-4-6": {
    isReasoning: true,
    supportsSampling: true,
    supportsStreaming: true,
    supportsCaching: true,
    thinkingEffort: true,
    thinkingBudget: true,
  },
  "claude-sonnet-4-6": {
    isReasoning: true,
    supportsSampling: true,
    supportsStreaming: true,
    supportsCaching: true,
    thinkingEffort: true,
    thinkingBudget: true,
  },
  "claude-3-5-sonnet": {
    isReasoning: false,
    supportsSampling: true,
    supportsStreaming: true,
    supportsCaching: true,
    thinkingEffort: false,
    thinkingBudget: false,
  },

  // ===== OpenAI 推理模型（只接受 effort）=====
  "o1": {
    isReasoning: true,
    supportsSampling: false,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: true,
    thinkingBudget: false,
  },
  "o3": {
    isReasoning: true,
    supportsSampling: false,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: true,
    thinkingBudget: false,
  },
  "o3-mini": {
    isReasoning: true,
    supportsSampling: false,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: true,
    thinkingBudget: false,
  },
  "gpt-5": {
    isReasoning: true,
    supportsSampling: false,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: true,
    thinkingBudget: false,
  },

  // ===== OpenAI 非推理模型 =====
  "gpt-4o": {
    isReasoning: false,
    supportsSampling: true,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: false,
    thinkingBudget: false,
  },
  "gpt-4-1": {
    isReasoning: false,
    supportsSampling: true,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: false,
    thinkingBudget: false,
  },

  // ===== DeepSeek =====
  "deepseek-reasoner": {
    isReasoning: true, // 是推理模型，但没旋钮可调（thinkingEffort/Budget 都 false）
    supportsSampling: false,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: false,
    thinkingBudget: false,
  },
  "deepseek-chat": {
    isReasoning: false,
    supportsSampling: true,
    supportsStreaming: true,
    supportsCaching: false,
    thinkingEffort: false,
    thinkingBudget: false,
  },
};

// ------------------------- 默认 capability -------------------------

const DEFAULT_CAPABILITY: ModelCapability = {
  isReasoning: false,
  supportsSampling: true,
  supportsStreaming: true,
  supportsCaching: false,
  thinkingEffort: false,
  thinkingBudget: false,
};

// ------------------------- 规范化 -------------------------

/**
 * 把用户传的 modelId 变成能在表里查到的 key。
 *
 * 例子：
 *   "anthropic/claude-opus-4.7"           → "claude-opus-4-7"
 *   "claude-opus-4-7-20260101"            → "claude-opus-4-7"
 *   "openai/gpt-4o@latest"                → "gpt-4o"
 *   "claude-3-5-sonnet-20241022"          → "claude-3-5-sonnet"
 */
export function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();

  // 去 provider 前缀："anthropic/xxx" → "xxx"
  const slashIdx = id.lastIndexOf("/");
  if (slashIdx !== -1) id = id.slice(slashIdx + 1);

  // 去 @tag 后缀："xxx@latest" → "xxx"
  const atIdx = id.indexOf("@");
  if (atIdx !== -1) id = id.slice(0, atIdx);

  // 去 :tag 后缀（有些网关用冒号）
  const colonIdx = id.indexOf(":");
  if (colonIdx !== -1) id = id.slice(0, colonIdx);

  // 点号统一成横杠
  // OpenRouter 用 "claude-opus-4.7"，Anthropic 原生用 "claude-opus-4-7"
  id = id.replace(/\./g, "-");

  return id;
}

// ------------------------- 查询 -------------------------

export function getCapability(modelId: string): ModelCapability {
  const norm = normalizeModelId(modelId);

  // 1. 精确命中
  if (TABLE[norm]) return TABLE[norm];

  // 2. 前缀命中：表里有 "claude-opus-4-7"，查的是 "claude-opus-4-7-20260101"
  //    遍历表 key，找最长的那个能当前缀匹配到的
  let best: string | null = null;
  for (const key of Object.keys(TABLE)) {
    if (norm.startsWith(key) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  if (best) return TABLE[best];

  // 3. 兜底
  return DEFAULT_CAPABILITY;
}

// ------------------------- 调试用 -------------------------

/** 返回表里所有已知模型 key（给 UI 下拉建议用） */
export function listKnownModels(): string[] {
  return Object.keys(TABLE);
}
