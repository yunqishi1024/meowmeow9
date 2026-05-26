// Provider 模块统一出口
export * from "./types";
export { getCapability, normalizeModelId, listKnownModels } from "./capabilities";
export { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

import type { ChatProvider, ProviderConfig } from "./types";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

/**
 * 从用户配置构造一个 Provider 实例。
 * UI 层只要拿到 ProviderConfig 就能通过这个函数得到能发请求的 Provider。
 */
export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(
        config.name,
        config.baseUrl,
        config.apiKey,
      );
    case "anthropic":
      // 今晚暂时没实现原生 Anthropic provider。
      // 想走 Anthropic 原生 API 的用户可以先用 OpenRouter 绕一下。
      throw new Error(
        "Native Anthropic provider not implemented yet. " +
          "Use OpenRouter (openai-compatible) for now.",
      );
    default: {
      const _exhaustive: never = config.kind;
      throw new Error(`Unknown provider kind: ${_exhaustive}`);
    }
  }
}
