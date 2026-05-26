const CORS_METHODS = "GET, POST, PUT, DELETE, HEAD, OPTIONS";
const CORS_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Last-Event-ID",
  "MCP-Method",
  "MCP-Name",
  "MCP-Protocol-Version",
  "Mcp-Session-Id",
  "X-Cedar-Gateway-Version",
].join(", ");
const EXPOSED_HEADERS = [
  "MCP-Protocol-Version",
  "Mcp-Session-Id",
  "mcp-session-id",
  "X-Cedar-AI-Run-Id",
  "X-Cedar-AI-Run-Status",
  "X-Cedar-Gateway-Version",
  "X-Cedar-Sync-Updated-At",
  "X-Cedar-Sync-Version",
].join(", ");

const ROUTE_PATTERN = /^\/mcp\/([A-Za-z0-9_.-]+)\/?$/;
const SYNC_PREFIX = "/sync";
const SYNC_SNAPSHOT_PATH = "/sync/snapshot";
const SYNC_HEALTH_PATH = "/sync/health";
const SYNC_BLOB_PATTERN = /^\/sync\/blob\/([A-Za-z0-9_-]{6,160})$/;
const SYNC_V2_OBJECT_KEY_PATTERN = /^[A-Za-z0-9_.\/=-]{1,512}$/;
const AI_PREFIX = "/ai";
const AI_RUN_PATTERN = /^\/ai\/runs\/([A-Za-z0-9_-]{8,220})(\/stream)?$/;
const CONVERSATIONS_PREFIX = "/conversations";

const STREAM_SAVE_INTERVAL_MS = 1000;

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, { fetcher: fetch, ctx });
  },
};

export async function handleRequest(request, env = {}, options = {}) {
  const requestUrl = new URL(request.url);
  const cors = getCorsHeaders(request, env);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: cors.allowed ? 204 : 403,
      headers: cors.headers,
    });
  }
  if (requestUrl.pathname === "/" || requestUrl.pathname === "/health") {
    return jsonResponse(
      { ok: true, service: "cedar-cloud-gateway", version: 2 },
      { status: 200, cors },
    );
  }
  if (!cors.allowed) {
    return jsonResponse(
      { error: "origin_not_allowed" },
      { status: 403, cors },
    );
  }

  // ─── Cloud Gateway: /ai/generate + /ai/runs ─────────────────────────────
  if (requestUrl.pathname.startsWith(AI_PREFIX)) {
    return handleAiRequest(request, env, cors, options);
  }

  // ─── Cloud Gateway: /conversations CRUD ─────────────────────────────────
  if (requestUrl.pathname.startsWith(CONVERSATIONS_PREFIX)) {
    return handleConversationsRequest(request, env, cors);
  }

  // ─── Sync ────────────────────────────────────────────────────────────────
  if (requestUrl.pathname.startsWith(SYNC_PREFIX)) {
    return handleSyncRequest(request, env, cors);
  }

  // ─── MCP Proxy ──────────────────────────────────────────────────────────
  const routeMatch = requestUrl.pathname.match(ROUTE_PATTERN);
  if (!routeMatch) {
    return jsonResponse(
      { error: "not_found", hint: "Use /mcp/<target-name>." },
      { status: 404, cors },
    );
  }
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return jsonResponse(
      { error: "method_not_allowed" },
      { status: 405, cors, extraHeaders: { Allow: CORS_METHODS } },
    );
  }

  const gatewayAuth = authorizeGateway(request, env);
  if (!gatewayAuth.ok) {
    return jsonResponse(
      { error: "unauthorized" },
      {
        status: 401,
        cors,
        extraHeaders: { "WWW-Authenticate": 'Bearer realm="mcp-gateway"' },
      },
    );
  }

  let target;
  try {
    target = await resolveTarget(routeMatch[1], env);
  } catch (error) {
    return jsonResponse(
      { error: "bad_gateway_config", message: error.message },
      { status: 500, cors },
    );
  }
  if (!target) {
    return jsonResponse({ error: "unknown_target" }, { status: 404, cors });
  }
  if (!isManagedSecretTargetProtected(target, env)) {
    return jsonResponse(
      {
        error: "gateway_auth_required",
        message:
          "Targets with gateway-managed upstream tokens require GATEWAY_BEARER_TOKEN.",
      },
      { status: 500, cors },
    );
  }
  if (await shouldSwallowInitializedNotification(request, target)) {
    return new Response(null, {
      status: 202,
      headers: cors.headers,
    });
  }

  const upstreamUrl = buildUpstreamUrl(target, requestUrl, env);
  if (!upstreamUrl) {
    return jsonResponse({ error: "bad_target_url" }, { status: 500, cors });
  }
  if (
    upstreamUrl.protocol !== "https:" &&
    String(env.ALLOW_HTTP_TARGETS ?? "").toLowerCase() !== "true"
  ) {
    return jsonResponse(
      { error: "insecure_target", message: "Target URLs must use HTTPS." },
      { status: 500, cors },
    );
  }

  const upstreamHeaders = buildUpstreamHeaders(request, target, env);
  const fetcher = options.fetcher ?? fetch;
  try {
    const upstreamResponse = await fetcher(upstreamUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method === "GET" ? undefined : request.body,
      redirect: "follow",
    });
    return addCorsToResponse(upstreamResponse, cors);
  } catch (error) {
    return jsonResponse(
      {
        error: "upstream_fetch_failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502, cors },
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI REQUEST HANDLER (Cloud Gateway v2 + Legacy AI Gateway v1)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAiRequest(request, env, cors, options = {}) {
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === "/ai/health") {
    return jsonResponse(
      {
        ok: true,
        service: "cedar-chat-ai-gateway",
        bucketBound: Boolean(env.CEDAR_SYNC_BUCKET),
        version: 2,
      },
      { status: 200, cors },
    );
  }

  if (!env.CEDAR_SYNC_BUCKET) {
    return jsonResponse(
      {
        error: "sync_bucket_not_configured",
        message: "Bind an R2 bucket as CEDAR_SYNC_BUCKET.",
      },
      { status: 500, cors },
    );
  }

  // ─── NEW: POST /ai/generate (Cloud Gateway v2) ──────────────────────────
  if (requestUrl.pathname === "/ai/generate" && request.method === "POST") {
    const auth = await authorizeSyncRequest(request);
    if (!auth.ok) {
      return jsonResponse(
        { error: auth.error },
        { status: 401, cors, extraHeaders: { "WWW-Authenticate": 'Bearer realm="cedar-chat-ai"' } },
      );
    }
    return handleCloudGenerate(request, env, cors, auth.namespace, options);
  }

  // ─── NEW: /ai/runs/:runId/subscribe (SSE resumption) ────────────────────
  const subscribeMatch = requestUrl.pathname.match(/^\/ai\/runs\/([A-Za-z0-9_-]{8,220})\/subscribe$/);
  if (subscribeMatch && request.method === "GET") {
    const auth = await authorizeSyncRequest(request);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, { status: 401, cors });
    }
    return handleCloudSubscribe(request, env, cors, auth.namespace, subscribeMatch[1]);
  }

  // ─── NEW: POST /ai/runs/:runId/tool-result ──────────────────────────────
  const toolResultMatch = requestUrl.pathname.match(/^\/ai\/runs\/([A-Za-z0-9_-]{8,220})\/tool-result$/);
  if (toolResultMatch && request.method === "POST") {
    const auth = await authorizeSyncRequest(request);
    if (!auth.ok) {
      return jsonResponse({ error: auth.error }, { status: 401, cors });
    }
    return handleCloudToolResult(request, env, cors, auth.namespace, toolResultMatch[1]);
  }

  // ─── Legacy AI Gateway (v1): /ai/runs/:runId and /ai/runs/:runId/stream ─
  const auth = await authorizeSyncRequest(request);
  if (!auth.ok) {
    return jsonResponse(
      { error: auth.error },
      {
        status: 401,
        cors,
        extraHeaders: { "WWW-Authenticate": 'Bearer realm="cedar-chat-ai"' },
      },
    );
  }

  const runMatch = requestUrl.pathname.match(AI_RUN_PATTERN);
  if (!runMatch) {
    return jsonResponse({ error: "not_found" }, { status: 404, cors });
  }

  const runId = runMatch[1];
  const isStreamPath = Boolean(runMatch[2]);

  // Check both v2 (gw/) and v1 (sync/) namespaces
  const v2Key = `gw/${auth.namespace.replace("sync/", "")}` + `/runs/${runId}.json`;
  const v1Key = `${auth.namespace}/ai-runs/${runId}.json`;

  if (isStreamPath) {
    if (request.method !== "POST") {
      return jsonResponse(
        { error: "method_not_allowed" },
        { status: 405, cors, extraHeaders: { Allow: "POST, OPTIONS" } },
      );
    }
    return handleAiRunStream(request, env, cors, v1Key, runId, options);
  }

  // GET/HEAD/DELETE on run — try v2 key first, fall back to v1
  const objectKey = v1Key;

  if (request.method === "GET" || request.method === "HEAD") {
    // Try v2 namespace first
    let object = await env.CEDAR_SYNC_BUCKET.get(v2Key);
    if (!object) object = await env.CEDAR_SYNC_BUCKET.get(v1Key);

    if (!object) {
      return request.method === "HEAD"
        ? new Response(null, { status: 404, headers: cors.headers })
        : jsonResponse({ error: "not_found" }, { status: 404, cors });
    }
    const headers = new Headers(cors.headers);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set(
      "X-Cedar-AI-Run-Status",
      object.customMetadata?.status ?? "unknown",
    );
    return new Response(request.method === "HEAD" ? null : object.body, {
      status: 200,
      headers,
    });
  }

  if (request.method === "DELETE") {
    await env.CEDAR_SYNC_BUCKET.delete(v2Key);
    await env.CEDAR_SYNC_BUCKET.delete(v1Key);
    return jsonResponse({ ok: true }, { status: 200, cors });
  }

  return jsonResponse(
    { error: "method_not_allowed" },
    { status: 405, cors, extraHeaders: { Allow: "GET, HEAD, DELETE, OPTIONS" } },
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLOUD GATEWAY v2: /ai/generate
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCloudGenerate(request, env, cors, namespace, options) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400, cors });
  }

  const { upstream, model, messages, conversationId, assistantMessageId } = payload;
  if (!upstream?.baseUrl || !upstream?.apiKey || !model || !Array.isArray(messages) || !conversationId || !assistantMessageId) {
    return jsonResponse({ error: "missing_required_fields" }, { status: 400, cors });
  }

  // 1. Assemble system prompt
  const systemContent = buildSystemContent(payload);

  // 2. Assemble messages (pin/summary + historyDepth + style)
  const modelMessages = Array.isArray(payload.overrideMessages) && payload.overrideMessages.length > 0
  ? payload.overrideMessages
  : buildModelMessages(payload);

  // 3. Build upstream request body
  const requestBody = buildUpstreamRequestBody(payload, systemContent, modelMessages);

  // 4. Create run record
  const runId = `run_${assistantMessageId}_${Date.now().toString(36)}_${randomSuffix()}`;
  const now = new Date().toISOString();

  // Use gw/ prefix for v2 cloud gateway data (separate from sync/ namespace)
  const gwNamespace = `gw/${namespace.replace("sync/", "")}`;
  const runKey = `${gwNamespace}/runs/${runId}.json`;

  const runRecord = {
    app: "cedar-cloud-gateway-run",
    version: 2,
    runId,
    conversationId,
    assistantMessageId,
    model,
    status: "streaming",
    createdAt: now,
    updatedAt: now,
    chunks: [],
    thinkingText: "",
    contentText: "",
    toolCalls: [],
    usage: null,
    error: null,
    round: 0,
    pendingToolRequest: null,
  };

  await putObject(env, runKey, runRecord);

  // 5. Persist user message
  if (!(Array.isArray(payload.overrideMessages) && payload.overrideMessages.length > 0)) {
    const userMessage = messages[messages.length - 1];
    if (userMessage && userMessage.role === "user") {
      await persistMessage(env, gwNamespace, conversationId, userMessage);
    }
  }


  // 6. Call upstream and stream back
  const upstreamBaseUrl = upstream.baseUrl.replace(/\/+$/, "");
  let upstreamUrl;
  try {
    upstreamUrl = new URL(`${upstreamBaseUrl}/chat/completions`);
  } catch {
    return jsonResponse({ error: "bad_upstream_url" }, { status: 400, cors });
  }
  if (upstreamUrl.protocol !== "https:" && upstreamUrl.hostname !== "localhost" && upstreamUrl.hostname !== "127.0.0.1") {
    return jsonResponse({ error: "insecure_target" }, { status: 400, cors });
  }

  const fetcher = options.fetcher ?? fetch;
  let upstreamResponse;
  try {
    upstreamResponse = await fetcher(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${upstream.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    runRecord.status = "error";
    runRecord.error = err instanceof Error ? err.message : String(err);
    runRecord.updatedAt = new Date().toISOString();
    await putObject(env, runKey, runRecord);
    return jsonResponse(
      { error: "upstream_fetch_failed", message: runRecord.error, runId },
      { status: 502, cors },
    );
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => "");
    runRecord.status = "error";
    runRecord.error = `Upstream ${upstreamResponse.status}: ${text.slice(0, 2000)}`;
    runRecord.updatedAt = new Date().toISOString();
    await putObject(env, runKey, runRecord);
    return jsonResponse(
      { error: "upstream_error", message: runRecord.error, runId },
      { status: upstreamResponse.status, cors },
    );
  }

  // Pipe upstream SSE → client + R2 persistence
  const { readable, writable } = new TransformStream();

  const pipePromise = pipeCloudStreamToClientAndR2(
    upstreamResponse, writable, env, runKey, runRecord, gwNamespace, payload
  );
  if (options.ctx?.waitUntil) {
    options.ctx.waitUntil(pipePromise);
  } else {
    pipePromise.catch(() => {});
  }

  const headers = new Headers(cors.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Cedar-AI-Run-Id", runId);
  headers.set("X-Cedar-Gateway-Version", "2");

  return new Response(readable, { status: 200, headers });
}

async function pipeCloudStreamToClientAndR2(upstreamResponse, writable, env, runKey, runRecord, namespace, payload) {
  const reader = upstreamResponse.body.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let clientOpen = true;
  let lastSavedAt = 0;

  async function save(status = runRecord.status) {
    runRecord.status = status;
    runRecord.updatedAt = new Date().toISOString();
    await putObject(env, runKey, runRecord);
    lastSavedAt = Date.now();
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text) {
        runRecord.chunks.push(text);
        parseSSEChunks(text, runRecord);
      }

      // Forward to client
      if (clientOpen) {
        try {
          await writer.write(value);
        } catch {
          clientOpen = false;
        }
      }

      // Persist periodically
      if (Date.now() - lastSavedAt >= STREAM_SAVE_INTERVAL_MS) {
        await save("streaming");
      }
    }

    const finalText = decoder.decode();
    if (finalText) {
      runRecord.chunks.push(finalText);
      parseSSEChunks(finalText, runRecord);
    }

    await save("done");

    // Persist assistant message
    await persistAssistantMessage(env, namespace, payload.conversationId, runRecord);

    if (clientOpen) {
      try { await writer.close(); } catch { /* client gone */ }
    }
  } catch (err) {
    runRecord.error = err instanceof Error ? err.message : String(err);
    await save("error");
    if (clientOpen) {
      try { await writer.abort(err); } catch { /* client gone */ }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

// Parse SSE to extract content/thinking/toolCalls/usage
function parseSSEChunks(text, runRecord) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) {
        // Check for usage in final chunk
        if (parsed.usage) {
          runRecord.usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
            cachedInputTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
        continue;
      }

      if (delta.content) {
        runRecord.contentText += delta.content;
      }
      if (delta.reasoning_content || delta.thinking) {
        runRecord.thinkingText += (delta.reasoning_content || delta.thinking || "");
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!runRecord.toolCalls[idx]) {
            runRecord.toolCalls[idx] = { id: tc.id || "", function: { name: "", arguments: "" } };
          }
          if (tc.id) runRecord.toolCalls[idx].id = tc.id;
          if (tc.function?.name) runRecord.toolCalls[idx].function.name += tc.function.name;
          if (tc.function?.arguments) runRecord.toolCalls[idx].function.arguments += tc.function.arguments;
        }
      }
      if (parsed.usage) {
        runRecord.usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          cachedInputTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
    } catch { /* non-JSON SSE line, ignore */ }
  }
}

// ─── System Prompt Assembly ────────────────────────────────────────────────

function buildSystemContent(payload) {
  const { agent, injectCurrentTime } = payload;
  const parts = [];

  if (agent?.profile) parts.push(agent.profile);
  if (agent?.memory) parts.push(`<memory>\n${agent.memory}\n</memory>`);
  if (agent?.instructions) parts.push(agent.instructions);
  if (agent?.worldBook) parts.push(`<world-book>\n${agent.worldBook}\n</world-book>`);

  if (injectCurrentTime) {
    parts.push(`Current time: ${new Date().toISOString()}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// ─── Message Assembly (Pin/Summary + HistoryDepth + Style) ─────────────────

function buildModelMessages(payload) {
  const { messages, pinnedSummary, historyDepth, userStyle, contextPromptCache } = payload;

  let assembled;

  if (pinnedSummary?.text && pinnedSummary?.pinnedAtMessageId) {
    const pinIdx = messages.findIndex(m => m.id === pinnedSummary.pinnedAtMessageId);
    const postPinMessages = pinIdx >= 0 ? messages.slice(pinIdx) : messages;

    const summaryText = pinnedSummary.text.trim() || "There were no earlier messages before the pinned point.";
    const cacheCtrl = contextPromptCache && contextPromptCache !== "off"
      ? { type: "ephemeral", ...(contextPromptCache === "1h" ? { ttl: "1h" } : {}) }
      : undefined;

    assembled = [
      {
        role: "user",
        content: [{
          type: "text",
          text: `<conversation-summary>\n${summaryText}\n</conversation-summary>\n\nThe above is a summary of our earlier conversation. Continue from here.`,
          ...(cacheCtrl ? { cache_control: cacheCtrl } : {}),
        }],
      },
      {
        role: "assistant",
        content: "Understood. I have the context from our earlier conversation. Let's continue.",
      },
      ...postPinMessages.map(m => ({ role: m.role, content: m.content })),
    ];
  } else {
    const depth = historyDepth === "all" ? messages.length : Math.max(1, historyDepth + 1);
    const trimmed = messages.slice(-depth);
    assembled = trimmed.map(m => ({ role: m.role, content: m.content }));
  }

  // Inject userStyle into last user message
  if (userStyle?.trim()) {
    const styleText = `<userStyle>${userStyle.trim()}</userStyle>`;
    const lastUserIdx = assembled.map(m => m.role).lastIndexOf("user");
    if (lastUserIdx >= 0) {
      const msg = assembled[lastUserIdx];
      const parts = Array.isArray(msg.content) ? [...msg.content] : [{ type: "text", text: msg.content ?? "" }];
      parts.push({ type: "text", text: styleText });
      assembled[lastUserIdx] = { ...msg, content: parts };
    }
  }

  return assembled;
}

// ─── Upstream Request Body ─────────────────────────────────────────────────

function buildUpstreamRequestBody(payload, systemContent, modelMessages) {
  const { model, temperature, reasoning, maxTokens, tools, toolChoice } = payload;

  const body = {
    model,
    messages: modelMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (systemContent) {
    body.messages = [{ role: "system", content: systemContent }, ...body.messages];
  }

  if (typeof temperature === "number") body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;

  if (reasoning?.enabled) {
    if (reasoning.effort) body.reasoning_effort = reasoning.effort;
    if (reasoning.budgetTokens) body.thinking = { type: "enabled", budget_tokens: reasoning.budgetTokens };
  }

  if (tools && tools.length > 0) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }

  // Prompt cache (Claude-specific)
  if (payload.agentPromptCache && payload.agentPromptCache !== "off" && body.messages[0]?.role === "system") {
    const content = body.messages[0].content;
    if (typeof content === "string") {
      body.messages[0].content = [{
        type: "text",
        text: content,
        cache_control: { type: "ephemeral", ...(payload.agentPromptCache === "1h" ? { ttl: "1h" } : {}) },
      }];
    }
  }

  return body;
}

// ─── Cloud Subscribe (SSE resumption) ──────────────────────────────────────

async function handleCloudSubscribe(request, env, cors, namespace, runId) {
  const gwNamespace = `gw/${namespace.replace("sync/", "")}`;
  const runKey = `${gwNamespace}/runs/${runId}.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(runKey);
  if (!obj) {
    return jsonResponse({ error: "not_found" }, { status: 404, cors });
  }

  const record = JSON.parse(await obj.text());
  const lastEventId = parseInt(request.headers.get("Last-Event-ID") ?? "0", 10);

  const allChunks = record.chunks || [];
  const replayChunks = allChunks.slice(lastEventId);

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const writePromise = (async () => {
    try {
      let idx = lastEventId;
      for (const chunk of replayChunks) {
        await writer.write(encoder.encode(`id: ${idx}\ndata: ${JSON.stringify({ raw: chunk })}\n\n`));
        idx++;
      }

      if (record.status === "done") {
        await writer.write(encoder.encode(`event: done\ndata: ${JSON.stringify({
          status: "done",
          contentText: record.contentText,
          thinkingText: record.thinkingText,
          usage: record.usage,
        })}\n\n`));
      } else if (record.status === "error") {
        await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: record.error })}\n\n`));
      } else {
        await writer.write(encoder.encode(`event: streaming\ndata: ${JSON.stringify({
          status: "streaming",
          chunksCount: allChunks.length,
        })}\n\n`));
      }
      await writer.close();
    } catch {
      try { await writer.close(); } catch { /* */ }
    }
  })();

  writePromise.catch(() => {});

  const headers = new Headers(cors.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Cedar-AI-Run-Id", runId);
  headers.set("X-Cedar-AI-Run-Status", record.status);

  return new Response(readable, { status: 200, headers });
}

// ─── Cloud Tool Result ─────────────────────────────────────────────────────

async function handleCloudToolResult(request, env, cors, namespace, runId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400, cors });
  }

  const { toolCallId, result } = payload;
  if (!toolCallId || typeof result !== "string") {
    return jsonResponse({ error: "missing_tool_call_id_or_result" }, { status: 400, cors });
  }

  const gwNamespace = `gw/${namespace.replace("sync/", "")}`;
  const runKey = `${gwNamespace}/runs/${runId}.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(runKey);
  if (!obj) {
    return jsonResponse({ error: "run_not_found" }, { status: 404, cors });
  }

  const record = JSON.parse(await obj.text());
  if (!record.toolResults) record.toolResults = [];
  record.toolResults.push({ toolCallId, result });
  record.updatedAt = new Date().toISOString();

  await putObject(env, runKey, record);
  return jsonResponse({ ok: true, runId }, { cors });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATIONS CRUD (Cloud Gateway v2)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleConversationsRequest(request, env, cors) {
  if (!env.CEDAR_SYNC_BUCKET) {
    return jsonResponse(
      { error: "sync_bucket_not_configured" },
      { status: 500, cors },
    );
  }

  const auth = await authorizeSyncRequest(request);
  if (!auth.ok) {
    return jsonResponse(
      { error: auth.error },
      { status: 401, cors, extraHeaders: { "WWW-Authenticate": 'Bearer realm="cedar-chat"' } },
    );
  }

  const gwNamespace = `gw/${auth.namespace.replace("sync/", "")}`;
  const requestUrl = new URL(request.url);

  // GET /conversations — list
  if (requestUrl.pathname === "/conversations" && request.method === "GET") {
    return handleListConversations(env, cors, gwNamespace);
  }

  // POST /conversations — create
  if (requestUrl.pathname === "/conversations" && request.method === "POST") {
    return handleCreateConversation(request, env, cors, gwNamespace);
  }

  // /conversations/:id
  const convMatch = requestUrl.pathname.match(/^\/conversations\/([A-Za-z0-9_-]{2,100})$/);
  if (convMatch) {
    const convId = convMatch[1];
    if (request.method === "GET") return handleGetConversation(env, cors, gwNamespace, convId);
    if (request.method === "PUT") return handleUpdateConversation(request, env, cors, gwNamespace, convId);
    if (request.method === "DELETE") return handleDeleteConversation(env, cors, gwNamespace, convId);
  }

  // /conversations/:id/messages
  const msgsMatch = requestUrl.pathname.match(/^\/conversations\/([A-Za-z0-9_-]{2,100})\/messages$/);
  if (msgsMatch && request.method === "GET") {
    return handleGetMessages(env, cors, gwNamespace, msgsMatch[1]);
  }

  // /conversations/:id/messages/:msgId
  const msgDelMatch = requestUrl.pathname.match(
    /^\/conversations\/([A-Za-z0-9_-]{2,100})\/messages\/([A-Za-z0-9_-]{2,100})$/
  );
  if (msgDelMatch && request.method === "DELETE") {
    return handleDeleteMessage(env, cors, gwNamespace, msgDelMatch[1], msgDelMatch[2]);
  }

  return jsonResponse({ error: "not_found" }, { status: 404, cors });
}

async function handleListConversations(env, cors, namespace) {
  const prefix = `${namespace}/conversations/`;
  const listed = await env.CEDAR_SYNC_BUCKET.list({ prefix, delimiter: "/" });

  const conversationIds = [];
  for (const obj of listed.delimitedPrefixes || []) {
    const id = obj.replace(prefix, "").replace(/\/$/, "");
    if (id) conversationIds.push(id);
  }

  const metas = await Promise.all(
    conversationIds.slice(0, 200).map(async (id) => {
      const metaKey = `${prefix}${id}/meta.json`;
      const obj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
      if (!obj) return null;
      try {
        return { id, ...JSON.parse(await obj.text()) };
      } catch {
        return { id };
      }
    })
  );

  return jsonResponse({
    ok: true,
    conversations: metas.filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  }, { cors });
}

async function handleCreateConversation(request, env, cors, namespace) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400, cors });
  }

  const id = payload.id || `c_${randomSuffix()}`;
  const now = Date.now();
  const meta = {
    id,
    title: payload.title || "New conversation",
    model: payload.model || null,
    providerId: payload.providerId || null,
    agentId: payload.agentId || null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    ...payload,
  };

  const metaKey = `${namespace}/conversations/${id}/meta.json`;
  await putObject(env, metaKey, meta);

  return jsonResponse({ ok: true, conversation: meta }, { status: 201, cors });
}

async function handleGetConversation(env, cors, namespace, conversationId) {
  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (!obj) {
    return jsonResponse({ error: "not_found" }, { status: 404, cors });
  }

  const meta = JSON.parse(await obj.text());
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const msgsObj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  const messages = msgsObj ? JSON.parse(await msgsObj.text()) : [];

  return jsonResponse({ ok: true, conversation: { ...meta, messages } }, { cors });
}

async function handleUpdateConversation(request, env, cors, namespace, conversationId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400, cors });
  }

  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const existing = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (!existing) {
    return jsonResponse({ error: "not_found" }, { status: 404, cors });
  }

  const meta = JSON.parse(await existing.text());
  const updated = { ...meta, ...payload, id: conversationId, updatedAt: Date.now() };
  await putObject(env, metaKey, updated);

  return jsonResponse({ ok: true, conversation: updated }, { cors });
}

async function handleDeleteConversation(env, cors, namespace, conversationId) {
  const prefix = `${namespace}/conversations/${conversationId}/`;
  const listed = await env.CEDAR_SYNC_BUCKET.list({ prefix });
  const keys = listed.objects.map(obj => obj.key);

  if (keys.length > 0) {
    await env.CEDAR_SYNC_BUCKET.delete(keys);
  }

  return jsonResponse({ ok: true, deletedKeys: keys.length }, { cors });
}

async function handleGetMessages(env, cors, namespace, conversationId) {
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  if (!obj) {
    return jsonResponse({ ok: true, messages: [] }, { cors });
  }
  return jsonResponse({ ok: true, messages: JSON.parse(await obj.text()) }, { cors });
}

async function handleDeleteMessage(env, cors, namespace, conversationId, messageId) {
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  if (!obj) {
    return jsonResponse({ error: "conversation_not_found" }, { status: 404, cors });
  }

  const messages = JSON.parse(await obj.text());
  const filtered = messages.filter(m => m.id !== messageId);

  if (filtered.length === messages.length) {
    return jsonResponse({ error: "message_not_found" }, { status: 404, cors });
  }

  await putObject(env, messagesKey, filtered);

  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const metaObj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (metaObj) {
    const meta = JSON.parse(await metaObj.text());
    meta.messageCount = filtered.length;
    meta.updatedAt = Date.now();
    await putObject(env, metaKey, meta);
  }

  return jsonResponse({ ok: true, remainingMessages: filtered.length }, { cors });
}

// ─── Persistence Helpers ───────────────────────────────────────────────────

async function persistMessage(env, namespace, conversationId, message) {
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  const messages = obj ? JSON.parse(await obj.text()) : [];

  const existing = messages.findIndex(m => m.id === message.id);
  if (existing >= 0) {
    messages[existing] = message;
  } else {
    messages.push(message);
  }

  await putObject(env, messagesKey, messages);

  // Update meta
  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const metaObj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (metaObj) {
    const meta = JSON.parse(await metaObj.text());
    meta.messageCount = messages.length;
    meta.updatedAt = Date.now();
    await putObject(env, metaKey, meta);
  }
}

async function persistAssistantMessage(env, namespace, conversationId, runRecord) {
  const message = {
    id: runRecord.assistantMessageId,
    role: "assistant",
    model: runRecord.model,
    content: buildContentBlocks(runRecord),
    createdAt: new Date(runRecord.createdAt).getTime(),
    usage: runRecord.usage,
  };
  await persistMessage(env, namespace, conversationId, message);
}

function buildContentBlocks(runRecord) {
  const blocks = [];
  if (runRecord.thinkingText) {
    blocks.push({ type: "thinking", text: runRecord.thinkingText });
  }
  if (runRecord.contentText) {
    blocks.push({ type: "text", text: runRecord.contentText });
  }
  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY AI GATEWAY v1 (preserved for backward compat)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleAiRunStream(request, env, cors, objectKey, runId, options) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400, cors });
  }

  const upstream = payload?.upstream;
  const body = payload?.body;
  if (
    !upstream ||
    typeof upstream !== "object" ||
    typeof upstream.baseUrl !== "string" ||
    typeof upstream.apiKey !== "string" ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    return jsonResponse({ error: "invalid_ai_gateway_request" }, { status: 400, cors });
  }

  const upstreamBaseUrl = upstream.baseUrl.replace(/\/+$/, "");
  let upstreamUrl;
  try {
    upstreamUrl = new URL(`${upstreamBaseUrl}/chat/completions`);
  } catch {
    return jsonResponse({ error: "bad_upstream_url" }, { status: 400, cors });
  }
  if (
    upstreamUrl.protocol !== "https:" &&
    String(env.ALLOW_HTTP_TARGETS ?? "").toLowerCase() !== "true"
  ) {
    return jsonResponse(
      { error: "insecure_target", message: "AI upstream URLs must use HTTPS." },
      { status: 400, cors },
    );
  }

  const createdAt = new Date().toISOString();
  const record = {
    app: "cedar-chat-ai-run",
    version: 1,
    runId,
    status: "streaming",
    createdAt,
    updatedAt: createdAt,
    chunks: [],
  };
  await putAiRunRecord(env, objectKey, record);

  const fetcher = options.fetcher ?? fetch;
  let upstreamResponse;
  try {
    upstreamResponse = await fetcher(upstreamUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${upstream.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    record.status = "error";
    record.error = error instanceof Error ? error.message : String(error);
    record.updatedAt = new Date().toISOString();
    await putAiRunRecord(env, objectKey, record);
    return jsonResponse(
      { error: "upstream_fetch_failed", message: record.error },
      { status: 502, cors },
    );
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => "");
    record.status = "error";
    record.error = `Upstream ${upstreamResponse.status}: ${text.slice(0, 1000)}`;
    record.updatedAt = new Date().toISOString();
    await putAiRunRecord(env, objectKey, record);
    return jsonResponse(
      { error: "upstream_error", message: record.error },
      { status: upstreamResponse.ok ? 502 : upstreamResponse.status, cors },
    );
  }

  const { readable, writable } = new TransformStream();
  const streamPromise = pipeAiRunToClientAndStorage(
    upstreamResponse, writable, env, objectKey, record,
  );
  if (options.ctx?.waitUntil) {
    options.ctx.waitUntil(streamPromise);
  } else {
    streamPromise.catch(() => {});
  }

  const headers = new Headers(cors.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Cedar-AI-Run-Id", runId);
  return new Response(readable, { status: 200, headers });
}

async function pipeAiRunToClientAndStorage(upstreamResponse, writable, env, objectKey, record) {
  const reader = upstreamResponse.body.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let clientOpen = true;
  let lastSavedAt = 0;

  async function save(status = record.status) {
    record.status = status;
    record.updatedAt = new Date().toISOString();
    await putAiRunRecord(env, objectKey, record);
    lastSavedAt = Date.now();
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text) record.chunks.push(text);

      if (clientOpen) {
        try {
          await writer.write(value);
        } catch {
          clientOpen = false;
        }
      }

      if (Date.now() - lastSavedAt >= 1_000) {
        await save("streaming");
      }
    }

    const finalText = decoder.decode();
    if (finalText) record.chunks.push(finalText);
    await save("done");
    if (clientOpen) {
      try { await writer.close(); } catch { /* Client went away */ }
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    await save("error");
    if (clientOpen) {
      try { await writer.abort(error); } catch { /* Client is gone */ }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* Already released */ }
  }
}

async function putAiRunRecord(env, objectKey, record) {
  const body = JSON.stringify(record);
  await env.CEDAR_SYNC_BUCKET.put(objectKey, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      status: record.status,
      updatedAt: record.updatedAt,
      chunks: String(record.chunks.length),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSyncRequest(request, env, cors) {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === SYNC_HEALTH_PATH) {
    return jsonResponse(
      {
        ok: true,
        service: "cedar-chat-sync",
        bucketBound: Boolean(env.CEDAR_SYNC_BUCKET),
        version: 2,
      },
      { status: 200, cors, extraHeaders: { "X-Cedar-Sync-Version": "2" } },
    );
  }
  if (!env.CEDAR_SYNC_BUCKET) {
    return jsonResponse(
      {
        error: "sync_bucket_not_configured",
        message: "Bind an R2 bucket as CEDAR_SYNC_BUCKET.",
      },
      { status: 500, cors },
    );
  }
  const auth = await authorizeSyncRequest(request);
  if (!auth.ok) {
    return jsonResponse(
      { error: auth.error },
      {
        status: 401,
        cors,
        extraHeaders: { "WWW-Authenticate": 'Bearer realm="cedar-chat-sync"' },
      },
    );
  }

  if (requestUrl.pathname.startsWith("/sync/v2")) {
    return handleSyncV2Request(request, env, cors, auth.namespace);
  }
  const blobMatch = requestUrl.pathname.match(SYNC_BLOB_PATTERN);
  if (blobMatch) {
    return handleSyncBlobRequest(request, env, cors, auth.namespace, blobMatch[1]);
  }
  if (requestUrl.pathname === SYNC_SNAPSHOT_PATH) {
    return handleSyncSnapshotRequest(request, env, cors, auth.objectKey);
  }
  return jsonResponse({ error: "not_found" }, { status: 404, cors });
}

async function handleSyncSnapshotRequest(request, env, cors, objectKey) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return jsonResponse(
      { error: "method_not_allowed" },
      { status: 405, cors, extraHeaders: { Allow: CORS_METHODS } },
    );
  }
  if (request.method === "GET") {
    const object = await env.CEDAR_SYNC_BUCKET.get(objectKey);
    if (!object) {
      return jsonResponse({ error: "not_found" }, { status: 404, cors });
    }
    const headers = new Headers(cors.headers);
    headers.set("Content-Type", "application/json; charset=utf-8");
    const updatedAt = object.customMetadata?.updatedAt;
    if (updatedAt) headers.set("X-Cedar-Sync-Updated-At", updatedAt);
    return new Response(object.body, { status: 200, headers });
  }
  if (request.method === "DELETE") {
    await env.CEDAR_SYNC_BUCKET.delete(objectKey);
    return jsonResponse({ ok: true }, { status: 200, cors });
  }
  return putJsonObject(request, env, cors, objectKey, {
    emptyError: "empty_snapshot",
    tooLargeError: "snapshot_too_large",
    validateJson: true,
  });
}

async function handleSyncBlobRequest(request, env, cors, namespace, id) {
  const objectKey = `${namespace}/blob/${id}.json`;
  if (!["GET", "PUT", "POST", "DELETE", "HEAD"].includes(request.method)) {
    return jsonResponse(
      { error: "method_not_allowed" },
      { status: 405, cors, extraHeaders: { Allow: CORS_METHODS } },
    );
  }
  return handleObjectStorageRequest(request, env, cors, objectKey);
}

async function handleSyncV2Request(request, env, cors, namespace) {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === "/sync/v2/health") {
    return jsonResponse(
      { ok: true, service: "cedar-chat-sync", version: 2 },
      { status: 200, cors, extraHeaders: { "X-Cedar-Sync-Version": "2" } },
    );
  }
  if (requestUrl.pathname === "/sync/v2/manifest") {
    return handleObjectStorageRequest(
      request, env, cors, `${namespace}/v2/manifest.json`,
    );
  }
  if (requestUrl.pathname === "/sync/v2/object") {
    const key = requestUrl.searchParams.get("key") ?? "";
    if (!SYNC_V2_OBJECT_KEY_PATTERN.test(key) || key.includes("..")) {
      return jsonResponse({ error: "invalid_object_key" }, { status: 400, cors });
    }
    return handleObjectStorageRequest(
      request, env, cors, `${namespace}/v2/objects/${key}`,
    );
  }
  if (requestUrl.pathname === "/sync/v2/list") {
    if (request.method !== "GET") {
      return jsonResponse(
        { error: "method_not_allowed" },
        { status: 405, cors, extraHeaders: { Allow: CORS_METHODS } },
      );
    }
    const prefix = requestUrl.searchParams.get("prefix") ?? "";
    if (prefix && (!SYNC_V2_OBJECT_KEY_PATTERN.test(prefix) || prefix.includes(".."))) {
      return jsonResponse({ error: "invalid_prefix" }, { status: 400, cors });
    }
    const listed = await env.CEDAR_SYNC_BUCKET.list({
      prefix: `${namespace}/v2/objects/${prefix}`,
    });
    return jsonResponse(
      {
        ok: true,
        objects: listed.objects.map((object) => ({
          key: object.key.slice(`${namespace}/v2/objects/`.length),
          size: object.size,
          uploaded: object.uploaded,
          etag: object.etag,
          customMetadata: object.customMetadata,
        })),
      },
      { status: 200, cors },
    );
  }
  return jsonResponse({ error: "not_found" }, { status: 404, cors });
}

async function handleObjectStorageRequest(request, env, cors, objectKey) {
  if (!["GET", "PUT", "POST", "DELETE", "HEAD"].includes(request.method)) {
    return jsonResponse(
      { error: "method_not_allowed" },
      { status: 405, cors, extraHeaders: { Allow: CORS_METHODS } },
    );
  }
  if (request.method === "GET" || request.method === "HEAD") {
    const object = await env.CEDAR_SYNC_BUCKET.get(objectKey);
    if (!object) {
      return request.method === "HEAD"
        ? new Response(null, { status: 404, headers: cors.headers })
        : jsonResponse({ error: "not_found" }, { status: 404, cors });
    }
    const headers = new Headers(cors.headers);
    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType ?? "application/json; charset=utf-8",
    );
    const updatedAt = object.customMetadata?.updatedAt;
    if (updatedAt) headers.set("X-Cedar-Sync-Updated-At", updatedAt);
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(object.body, { status: 200, headers });
  }
  if (request.method === "DELETE") {
    await env.CEDAR_SYNC_BUCKET.delete(objectKey);
    return jsonResponse({ ok: true }, { status: 200, cors });
  }
  return putJsonObject(request, env, cors, objectKey, {
    emptyError: "empty_object",
    tooLargeError: "object_too_large",
    validateJson: true,
  });
}

async function putJsonObject(request, env, cors, objectKey, options) {
  const body = await request.text();
  const bytes = new TextEncoder().encode(body).byteLength;
  const maxBytes = Number.parseInt(env.MAX_SYNC_BYTES ?? "52428800", 10);
  if (!body.trim()) {
    return jsonResponse({ error: options.emptyError }, { status: 400, cors });
  }
  if (bytes > maxBytes) {
    return jsonResponse(
      {
        error: options.tooLargeError,
        message: `Object is ${bytes} bytes; max is ${maxBytes} bytes.`,
      },
      { status: 413, cors },
    );
  }
  if (options.validateJson) {
    try {
      JSON.parse(body);
    } catch {
      return jsonResponse({ error: "invalid_json" }, { status: 400, cors });
    }
  }

  const updatedAt = new Date().toISOString();
  await env.CEDAR_SYNC_BUCKET.put(objectKey, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { updatedAt, bytes: String(bytes) },
  });
  return jsonResponse(
    { ok: true, updatedAt, bytes },
    { status: 200, cors, extraHeaders: { "X-Cedar-Sync-Updated-At": updatedAt } },
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH & UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

async function authorizeSyncRequest(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!token) return { ok: false, error: "sync_token_required" };
  if (token.length < 8) return { ok: false, error: "sync_token_too_short" };
  const tokenHash = await sha256Hex(token);
  const namespace = `sync/${tokenHash}`;
  return {
    ok: true,
    namespace,
    objectKey: `${namespace}/snapshot.json`,
  };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function putObject(env, key, value) {
  const body = JSON.stringify(value);
  await env.CEDAR_SYNC_BUCKET.put(key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      status: value.status ?? "ok",
      updatedAt: value.updatedAt ?? new Date().toISOString(),
    },
  });
}

function randomSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── MCP Proxy Helpers ─────────────────────────────────────────────────────

export function parseTargets(rawTargets) {
  if (!rawTargets || !rawTargets.trim()) return {};
  const parsed = JSON.parse(rawTargets);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP_TARGETS must be a JSON object.");
  }
  const targets = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`Invalid target name: ${name}`);
    }
    if (typeof value === "string") {
      targets[name] = { url: value };
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid config for target: ${name}`);
    }
    targets[name] = {
      url: value.url,
      bearerEnv: value.bearerEnv,
      bearerToken: value.bearerToken,
      forwardClientAuthorization: value.forwardClientAuthorization === true,
      headers: normalizeStaticHeaders(value.headers),
      query: normalizeStaticQuery(value.query),
      queryEnv: normalizeStaticQuery(value.queryEnv),
      swallowInitializedNotification:
        value.swallowInitializedNotification === true,
    };
  }
  return targets;
}

async function resolveTarget(name, env) {
  const targets = parseTargets(env.MCP_TARGETS ?? "");
  if (targets[name]) return targets[name];
  if (env.MCP_TARGETS_KV && typeof env.MCP_TARGETS_KV.get === "function") {
    const raw = await env.MCP_TARGETS_KV.get(name);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value === "string") return { url: value };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid KV config for target: ${name}`);
    }
    return {
      url: value.url,
      bearerEnv: value.bearerEnv,
      bearerToken: value.bearerToken,
      forwardClientAuthorization: value.forwardClientAuthorization === true,
      headers: normalizeStaticHeaders(value.headers),
      query: normalizeStaticQuery(value.query),
      queryEnv: normalizeStaticQuery(value.queryEnv),
      swallowInitializedNotification:
        value.swallowInitializedNotification === true,
    };
  }
  return null;
}

function normalizeStaticHeaders(headers) {
  if (!headers) return {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("headers must be an object.");
  }
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw new Error(`Header ${key} must be a string.`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeStaticQuery(query) {
  if (!query) return {};
  if (typeof query !== "object" || Array.isArray(query)) {
    throw new Error("query and queryEnv must be objects.");
  }
  const normalized = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== "string") {
      throw new Error(`Query value ${key} must be a string.`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function buildUpstreamUrl(target, requestUrl, env) {
  try {
    const upstreamUrl = new URL(target.url);
    for (const [key, value] of Object.entries(target.query ?? {})) {
      upstreamUrl.searchParams.set(key, value);
    }
    for (const [key, envName] of Object.entries(target.queryEnv ?? {})) {
      const value = String(env[envName] ?? "");
      if (value) upstreamUrl.searchParams.set(key, value);
    }
    for (const [key, value] of requestUrl.searchParams) {
      upstreamUrl.searchParams.append(key, value);
    }
    return upstreamUrl;
  } catch {
    return null;
  }
}

function buildUpstreamHeaders(request, target, env) {
  const headers = new Headers();
  const copiedHeaders = [
    "accept",
    "content-type",
    "last-event-id",
    "mcp-protocol-version",
    "mcp-session-id",
  ];
  for (const headerName of copiedHeaders) {
    const value = request.headers.get(headerName);
    if (value) headers.set(headerName, value);
  }
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    headers.set(key, value);
  }
  const bearerToken = resolveTargetBearerToken(target, env);
  const clientAuthorization = request.headers.get("authorization");
  if (bearerToken) {
    headers.set("authorization", `Bearer ${bearerToken}`);
  } else if (target.forwardClientAuthorization && clientAuthorization) {
    headers.set("authorization", clientAuthorization);
  }
  return headers;
}

async function shouldSwallowInitializedNotification(request, target) {
  if (!target.swallowInitializedNotification) return false;
  if (request.method !== "POST") return false;
  try {
    const payload = await request.clone().json();
    return payload?.method === "notifications/initialized";
  } catch {
    return false;
  }
}

function resolveTargetBearerToken(target, env) {
  if (target.bearerEnv) return env[target.bearerEnv] || "";
  return target.bearerToken || "";
}

function isManagedSecretTargetProtected(target, env) {
  const targetHasGatewayManagedSecret = Boolean(
    target.bearerEnv ||
      target.bearerToken ||
      Object.keys(target.queryEnv ?? {}).length > 0,
  );
  if (!targetHasGatewayManagedSecret) return true;
  if (String(env.GATEWAY_BEARER_TOKEN ?? "").trim()) return true;
  return String(env.ALLOW_PUBLIC_SECRET_TARGETS ?? "").toLowerCase() === "true";
}

// ─── CORS & Response Helpers ───────────────────────────────────────────────

function getCorsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS ?? "");
  const allowAll = allowedOrigins.has("*");
  const originAllowed = !origin || allowAll || allowedOrigins.has(origin);
  const headers = new Headers({
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": CORS_HEADERS,
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
  if (origin && originAllowed) {
    headers.set("Access-Control-Allow-Origin", allowAll ? "*" : origin);
  }
  return { allowed: originAllowed, headers };
}

function parseAllowedOrigins(rawOrigins) {
  return new Set(
    rawOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function authorizeGateway(request, env) {
  const expectedToken = String(env.GATEWAY_BEARER_TOKEN ?? "").trim();
  if (!expectedToken) return { ok: true };
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  return { ok: safeEqual(token, expectedToken) };
}

function safeEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  let result = 0;
  for (let index = 0; index < actual.length; index += 1) {
    result |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return result === 0;
}

function addCorsToResponse(response, cors) {
  const headers = new Headers(response.headers);
  for (const [key, value] of cors.headers) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body, options = {}) {
  const headers = new Headers(options.extraHeaders ?? {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (options.cors) {
    for (const [key, value] of options.cors.headers) {
      headers.set(key, value);
    }
  }
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}
