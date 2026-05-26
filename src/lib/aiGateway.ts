import { OpenAICompatibleProvider } from "../providers/OpenAICompatibleProvider";
import type {
  ChatRequest,
  ChatStreamChunk,
  ProviderConfig,
} from "../providers/types";
import type { SyncSettings } from "./storage";

const ACTIVE_AI_RUN_KEY = "cedar-chat.activeAiGatewayRun";
const ACTIVE_AI_RUN_TTL_MS = 12 * 60 * 60 * 1000;

export interface ActiveAiGatewayRun {
  runId: string;
  providerId: string;
  conversationId: string;
  assistantMessageId: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface AiGatewayRunRecord {
  app: "cedar-chat-ai-run";
  version: 1;
  runId: string;
  status: "streaming" | "done" | "error";
  createdAt: string;
  updatedAt: string;
  chunks: string[];
  error?: string;
}

export function canUseAiGateway(
  settings: SyncSettings,
  provider: ProviderConfig | null,
): boolean {
  return Boolean(
    provider?.kind === "openai-compatible" &&
      settings.endpoint.trim() &&
      settings.syncCode.trim().length >= 8,
  );
}

export function newAiGatewayRunId(messageId: string, round: number): string {
  return `run_${messageId}_${round}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function aiGatewayAvailable(settings: SyncSettings): Promise<boolean> {
  if (!settings.endpoint.trim()) return false;
  try {
    const response = await fetch(aiGatewayUrl(settings.endpoint, "/ai/health"), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as unknown;
    return isRecord(payload) && payload.ok === true && payload.bucketBound === true;
  } catch {
    return false;
  }
}

export function saveActiveAiGatewayRun(run: ActiveAiGatewayRun): void {
  try {
    localStorage.setItem(ACTIVE_AI_RUN_KEY, JSON.stringify(run));
  } catch {
    // Best effort only. The normal local chat persistence still runs.
  }
}

export function loadActiveAiGatewayRun(): ActiveAiGatewayRun | null {
  try {
    const raw = localStorage.getItem(ACTIVE_AI_RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isActiveAiGatewayRun(parsed)) return null;
    if (parsed.updatedAt < Date.now() - ACTIVE_AI_RUN_TTL_MS) {
      clearActiveAiGatewayRun(parsed.runId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearActiveAiGatewayRun(runId?: string): void {
  try {
    if (!runId) {
      localStorage.removeItem(ACTIVE_AI_RUN_KEY);
      return;
    }
    const active = loadActiveAiGatewayRun();
    if (active?.runId === runId) localStorage.removeItem(ACTIVE_AI_RUN_KEY);
  } catch {
    // Best effort only.
  }
}

export async function* streamOpenAICompatibleViaGateway({
  settings,
  providerConfig,
  request,
  runId,
}: {
  settings: SyncSettings;
  providerConfig: ProviderConfig;
  request: ChatRequest;
  runId: string;
}): AsyncIterable<ChatStreamChunk> {
  const parser = openAIParser(providerConfig);
  const body = {
    ...parser.buildRequestBody(request),
    stream: true,
    stream_options: { include_usage: true },
  };

  const response = await fetch(aiGatewayUrl(settings.endpoint, `/ai/runs/${runId}/stream`), {
    method: "POST",
    headers: {
      ...authHeaders(settings),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      upstream: {
        name: providerConfig.name,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
      },
      body,
    }),
    signal: request.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`AI gateway error ${response.status}: ${text.slice(0, 500)}`);
  }

  yield* parser.streamResponse(response);
}

export async function pullAiGatewayRun(
  settings: SyncSettings,
  runId: string,
): Promise<AiGatewayRunRecord | null> {
  const response = await fetch(aiGatewayUrl(settings.endpoint, `/ai/runs/${runId}`), {
    method: "GET",
    headers: {
      ...authHeaders(settings),
      Accept: "application/json",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`AI gateway restore failed ${response.status}: ${text.slice(0, 500)}`);
  }
  const payload = (await response.json()) as unknown;
  return isAiGatewayRunRecord(payload) ? payload : null;
}

export async function* streamChunksFromAiGatewayRun(
  providerConfig: ProviderConfig,
  record: AiGatewayRunRecord,
): AsyncIterable<ChatStreamChunk> {
  const parser = openAIParser(providerConfig);
  const response = new Response(record.chunks.join(""));
  yield* parser.streamResponse(response);
}

function aiGatewayUrl(endpoint: string, path: string): string {
  const url = new URL(endpoint.trim());
  const basePath = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/sync\/snapshot$/, "")
    .replace(/\/sync\/blob\/[A-Za-z0-9_-]+$/, "")
    .replace(/\/sync$/, "");
  url.pathname = `${basePath}${path}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function authHeaders(settings: SyncSettings): Record<string, string> {
  return {
    Authorization: `Bearer ${settings.syncCode.trim()}`,
  };
}

function openAIParser(providerConfig: ProviderConfig): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(
    providerConfig.name,
    providerConfig.baseUrl,
    providerConfig.apiKey,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isActiveAiGatewayRun(value: unknown): value is ActiveAiGatewayRun {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.providerId === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.assistantMessageId === "string" &&
    typeof value.model === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isAiGatewayRunRecord(value: unknown): value is AiGatewayRunRecord {
  return (
    isRecord(value) &&
    value.app === "cedar-chat-ai-run" &&
    value.version === 1 &&
    typeof value.runId === "string" &&
    (value.status === "streaming" ||
      value.status === "done" ||
      value.status === "error") &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.chunks) &&
    value.chunks.every((chunk) => typeof chunk === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}
