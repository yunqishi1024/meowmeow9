/**
 * Cedar Chat Cloud Gateway Worker
 *
 * 职责:
 * 1. 接受前端的 generate 请求，组装 system prompt / pin / style / cache
 * 2. 调用上游 AI provider (stream)
 * 3. 实时持久化 stream chunks 到 R2
 * 4. SSE 推送给前端，支持 Last-Event-ID 断线续接
 * 5. 多轮 MCP tool loop（无状态 tools 在 Worker 执行）
 * 6. 对话/消息 CRUD（含删除）
 *
 * 部署: 在 Cloudflare Worker 中使用此文件替代或并行部署 index.js
 * 绑定: CEDAR_SYNC_BUCKET (R2), ALLOWED_ORIGINS (env var)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const CORS_METHODS = "GET, POST, PUT, DELETE, HEAD, OPTIONS";
const CORS_HEADERS = [
  "Accept",
  "Authorization",
  "Content-Type",
  "Last-Event-ID",
  "X-Cedar-Gateway-Version",
].join(", ");
const EXPOSED_HEADERS = [
  "X-Cedar-AI-Run-Id",
  "X-Cedar-AI-Run-Status",
  "X-Cedar-Gateway-Version",
].join(", ");

const MAX_TOOL_ROUNDS = 10;
const STREAM_SAVE_INTERVAL_MS = 1000;
const MAX_REQUEST_BYTES = 52_428_800; // 50MB

// ─── Entry Point ─────────────────────────────────────────────────────────────

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, { fetcher: fetch, ctx });
  },
};

export async function handleRequest(request, env = {}, options = {}) {
  const url = new URL(request.url);
  const cors = getCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: cors.allowed ? 204 : 403, headers: cors.headers });
  }

  if (url.pathname === "/" || url.pathname === "/health") {
    return json({ ok: true, service: "cedar-cloud-gateway", version: 2 }, { cors });
  }

  if (!cors.allowed) {
    return json({ error: "origin_not_allowed" }, { status: 403, cors });
  }

  const auth = await authorizeRequest(request);
  if (!auth.ok) {
    return json({ error: auth.error }, { status: 401, cors });
  }

  const { namespace } = auth;

  // ─── Route Dispatch ──────────────────────────────────────────────────────
  try {
    // POST /ai/generate
    if (url.pathname === "/ai/generate" && request.method === "POST") {
      return handleGenerate(request, env, cors, namespace, options);
    }

    // GET /ai/runs/:runId/subscribe
    const subscribeMatch = url.pathname.match(/^\/ai\/runs\/([A-Za-z0-9_-]{8,220})\/subscribe$/);
    if (subscribeMatch && request.method === "GET") {
      return handleSubscribe(request, env, cors, namespace, subscribeMatch[1]);
    }

    // GET /ai/runs/:runId
    const runGetMatch = url.pathname.match(/^\/ai\/runs\/([A-Za-z0-9_-]{8,220})$/);
    if (runGetMatch && (request.method === "GET" || request.method === "HEAD")) {
      return handleGetRun(request, env, cors, namespace, runGetMatch[1]);
    }

    // DELETE /ai/runs/:runId
    if (runGetMatch && request.method === "DELETE") {
      return handleDeleteRun(env, cors, namespace, runGetMatch[1]);
    }

    // POST /ai/runs/:runId/tool-result
    const toolResultMatch = url.pathname.match(/^\/ai\/runs\/([A-Za-z0-9_-]{8,220})\/tool-result$/);
    if (toolResultMatch && request.method === "POST") {
      return handleToolResult(request, env, cors, namespace, toolResultMatch[1]);
    }

    // ─── Conversations CRUD ────────────────────────────────────────────────

    // GET /conversations — list all conversations
    if (url.pathname === "/conversations" && request.method === "GET") {
      return handleListConversations(env, cors, namespace);
    }

    // POST /conversations — create conversation
    if (url.pathname === "/conversations" && request.method === "POST") {
      return handleCreateConversation(request, env, cors, namespace);
    }

    // GET /conversations/:id
    const convMatch = url.pathname.match(/^\/conversations\/([A-Za-z0-9_-]{2,100})$/);
    if (convMatch && request.method === "GET") {
      return handleGetConversation(env, cors, namespace, convMatch[1]);
    }

    // PUT /conversations/:id
    if (convMatch && request.method === "PUT") {
      return handleUpdateConversation(request, env, cors, namespace, convMatch[1]);
    }

    // DELETE /conversations/:id
    if (convMatch && request.method === "DELETE") {
      return handleDeleteConversation(env, cors, namespace, convMatch[1]);
    }

    // GET /conversations/:id/messages
    const msgsMatch = url.pathname.match(/^\/conversations\/([A-Za-z0-9_-]{2,100})\/messages$/);
    if (msgsMatch && request.method === "GET") {
      return handleGetMessages(env, cors, namespace, msgsMatch[1]);
    }

    // DELETE /conversations/:id/messages/:msgId
    const msgDelMatch = url.pathname.match(
      /^\/conversations\/([A-Za-z0-9_-]{2,100})\/messages\/([A-Za-z0-9_-]{2,100})$/
    );
    if (msgDelMatch && request.method === "DELETE") {
      return handleDeleteMessage(env, cors, namespace, msgDelMatch[1], msgDelMatch[2]);
    }

    return json({ error: "not_found" }, { status: 404, cors });
  } catch (err) {
    return json(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500, cors }
    );
  }
}

// ─── AI Generate ─────────────────────────────────────────────────────────────

async function handleGenerate(request, env, cors, namespace, options) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, cors });
  }

  // Validate required fields
  const { upstream, model, messages, conversationId, assistantMessageId } = payload;
  if (!upstream?.baseUrl || !upstream?.apiKey || !model || !Array.isArray(messages) || !conversationId || !assistantMessageId) {
    return json({ error: "missing_required_fields" }, { status: 400, cors });
  }

  // ─── 1. Assemble system prompt ─────────────────────────────────────────
  // 多轮 tool 循环 (overrideMessages 存在) 时：
  //   - 系统提示保持原样（agent 信息每轮都应当生效）
  //   - 但消息序列直接用前端传来的完整 modelMessages，不再走 pin/depth/style
  const systemContent = buildSystemContent(payload);

  // ─── 2. Assemble messages ──────────────────────────────────────────────
  const modelMessages = Array.isArray(payload.overrideMessages) && payload.overrideMessages.length > 0
    ? payload.overrideMessages
    : buildModelMessages(payload);

  // ─── 3. Build request body ─────────────────────────────────────────────
  const requestBody = buildUpstreamRequestBody(payload, systemContent, modelMessages);

  // ─── 4. Generate runId, persist initial record ─────────────────────────
  const runId = `run_${assistantMessageId}_${Date.now().toString(36)}_${randomSuffix()}`;
  const now = new Date().toISOString();

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

  const runKey = `${namespace}/runs/${runId}.json`;
  await putObject(env, runKey, runRecord);

  // ─── 5. Persist user message to R2 immediately ─────────────────────────
  // 仅在首轮 (没有 overrideMessages) 持久化 user message。
  // 工具循环的后续轮次最后一条是 role:"tool"，不应当再写一遍 user。
  if (!payload.overrideMessages) {
    const userMessage = messages[messages.length - 1];
    if (userMessage && userMessage.role === "user") {
      await persistMessage(env, namespace, conversationId, userMessage);
    }
  }

  // ─── 6. Start streaming in background ──────────────────────────────────
  const { readable, writable } = new TransformStream();

  const streamPromise = executeAiStream(
    env, options, namespace, runKey, runRecord, payload, requestBody
  );

  if (options.ctx?.waitUntil) {
    options.ctx.waitUntil(streamPromise);
  } else {
    streamPromise.catch(() => {});
  }

  // ─── 7. Return SSE stream to client ────────────────────────────────────
  // We stream inline: Worker calls upstream and pipes back to client simultaneously
  const streamResponse = await startInlineStream(
    env, options, namespace, runKey, runRecord, payload, requestBody, cors
  );

  return streamResponse;
}

async function startInlineStream(env, options, namespace, runKey, runRecord, payload, requestBody, cors) {
  const { upstream } = payload;
  const upstreamUrl = `${upstream.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(upstreamUrl);
  } catch {
    return json({ error: "bad_upstream_url" }, { status: 400, cors });
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
    return json({ error: "insecure_target" }, { status: 400, cors });
  }

  const fetcher = options.fetcher ?? fetch;
  let upstreamResponse;
  try {
    upstreamResponse = await fetcher(upstreamUrl, {
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
    return json({ error: "upstream_fetch_failed", message: runRecord.error, runId: runRecord.runId }, { status: 502, cors });
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => "");
    runRecord.status = "error";
    runRecord.error = `Upstream ${upstreamResponse.status}: ${text.slice(0, 2000)}`;
    runRecord.updatedAt = new Date().toISOString();
    await putObject(env, runKey, runRecord);
    return json({ error: "upstream_error", message: runRecord.error, runId: runRecord.runId }, { status: upstreamResponse.status, cors });
  }

  // Pipe upstream SSE → client + R2 persistence
  const { readable, writable } = new TransformStream();

  const pipePromise = pipeStreamToClientAndR2(
    upstreamResponse, writable, env, runKey, runRecord, namespace, payload
  );
  if (options.ctx?.waitUntil) {
    options.ctx.waitUntil(pipePromise);
  } else {
    pipePromise.catch(() => {});
  }

  const headers = new Headers(cors.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Cedar-AI-Run-Id", runRecord.runId);
  headers.set("X-Cedar-Gateway-Version", "2");

  return new Response(readable, { status: 200, headers });
}

async function pipeStreamToClientAndR2(upstreamResponse, writable, env, runKey, runRecord, namespace, payload) {
  const reader = upstreamResponse.body.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  let clientOpen = true;
  let lastSavedAt = 0;
  let eventIndex = 0;

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
        // Parse SSE for content extraction
        parseSSEChunks(text, runRecord);
      }

      // Forward to client with event IDs for resumption
      if (clientOpen) {
        try {
          const sseFrame = `id: ${eventIndex}\n${text.startsWith("data:") ? text : `data: ${text}\n\n`}`;
          await writer.write(new TextEncoder().encode(text));
          eventIndex++;
        } catch {
          clientOpen = false;
        }
      }

      // Persist to R2 periodically
      if (Date.now() - lastSavedAt >= STREAM_SAVE_INTERVAL_MS) {
        await save("streaming");
      }
    }

    // Final flush
    const finalText = decoder.decode();
    if (finalText) {
      runRecord.chunks.push(finalText);
      parseSSEChunks(finalText, runRecord);
    }

    await save("done");

    // Persist final assistant message
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

// Parse SSE text to extract content/thinking for the run record
function parseSSEChunks(text, runRecord) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

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

// ─── System Prompt Assembly ──────────────────────────────────────────────────

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

// ─── Message Assembly (Pin/Summary + HistoryDepth + Style) ───────────────────

function buildModelMessages(payload) {
  const { messages, pinnedSummary, historyDepth, userStyle, contextPromptCache } = payload;

  let assembled;

  if (pinnedSummary?.text && pinnedSummary?.pinnedAtMessageId) {
    // Find pin point
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
    // Apply historyDepth truncation
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

// ─── Upstream Request Body ───────────────────────────────────────────────────

function buildUpstreamRequestBody(payload, systemContent, modelMessages) {
  const { model, temperature, reasoning, maxTokens, tools, toolChoice } = payload;

  const body = {
    model,
    messages: modelMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (systemContent) {
    // For OpenAI-compatible: system message at front
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

// ─── Subscribe (SSE resumption) ──────────────────────────────────────────────

async function handleSubscribe(request, env, cors, namespace, runId) {
  const runKey = `${namespace}/runs/${runId}.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(runKey);
  if (!obj) {
    return json({ error: "not_found" }, { status: 404, cors });
  }

  const record = JSON.parse(await obj.text());
  const lastEventId = parseInt(request.headers.get("Last-Event-ID") ?? "0", 10);

  // Replay chunks from the requested offset
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

      // If done/error, send final event
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
        // Still streaming - tell client to poll or re-subscribe
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

// ─── Get Run ─────────────────────────────────────────────────────────────────

async function handleGetRun(request, env, cors, namespace, runId) {
  const runKey = `${namespace}/runs/${runId}.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(runKey);
  if (!obj) {
    return request.method === "HEAD"
      ? new Response(null, { status: 404, headers: cors.headers })
      : json({ error: "not_found" }, { status: 404, cors });
  }

  const headers = new Headers(cors.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Cedar-AI-Run-Status", obj.customMetadata?.status ?? "unknown");

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

// ─── Delete Run ──────────────────────────────────────────────────────────────

async function handleDeleteRun(env, cors, namespace, runId) {
  const runKey = `${namespace}/runs/${runId}.json`;
  await env.CEDAR_SYNC_BUCKET.delete(runKey);
  return json({ ok: true }, { cors });
}

// ─── Tool Result (client callback for local-only tools) ──────────────────────

async function handleToolResult(request, env, cors, namespace, runId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, cors });
  }

  const { toolCallId, result } = payload;
  if (!toolCallId || typeof result !== "string") {
    return json({ error: "missing_tool_call_id_or_result" }, { status: 400, cors });
  }

  const runKey = `${namespace}/runs/${runId}.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(runKey);
  if (!obj) {
    return json({ error: "run_not_found" }, { status: 404, cors });
  }

  const record = JSON.parse(await obj.text());

  // Store tool result in the run record for the next round
  if (!record.toolResults) record.toolResults = [];
  record.toolResults.push({ toolCallId, result });
  record.updatedAt = new Date().toISOString();

  await putObject(env, runKey, record);
  return json({ ok: true, runId }, { cors });
}

// ─── Conversations CRUD ──────────────────────────────────────────────────────

async function handleListConversations(env, cors, namespace) {
  const prefix = `${namespace}/conversations/`;
  const listed = await env.CEDAR_SYNC_BUCKET.list({ prefix, delimiter: "/" });

  // Each conversation is stored as namespace/conversations/<id>/meta.json
  const conversationIds = [];
  for (const obj of listed.delimitedPrefixes || []) {
    const id = obj.replace(prefix, "").replace(/\/$/, "");
    if (id) conversationIds.push(id);
  }

  // Fetch meta for each (parallel, limited)
  const metas = await Promise.all(
    conversationIds.slice(0, 200).map(async (id) => {
      const metaKey = `${prefix}${id}/meta.json`;
      const obj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
      if (!obj) return null;
      try {
        const meta = JSON.parse(await obj.text());
        return { id, ...meta };
      } catch {
        return { id };
      }
    })
  );

  return json({
    ok: true,
    conversations: metas.filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  }, { cors });
}

async function handleCreateConversation(request, env, cors, namespace) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, cors });
  }

  const id = payload.id || `c_${randomSuffix()}`;
  const now = Date.now();
  const meta = {
    id,
    title: payload.title || "New conversation",
    model: payload.model || null,
    providerId: payload.providerId || null,
    agentId: payload.agentId || null,
    temperature: payload.temperature ?? 0.7,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    ...payload,
  };

  const metaKey = `${namespace}/conversations/${id}/meta.json`;
  await putObject(env, metaKey, meta);

  return json({ ok: true, conversation: meta }, { status: 201, cors });
}

async function handleGetConversation(env, cors, namespace, conversationId) {
  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (!obj) {
    return json({ error: "not_found" }, { status: 404, cors });
  }

  const meta = JSON.parse(await obj.text());

  // Also load messages
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const msgsObj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  const messages = msgsObj ? JSON.parse(await msgsObj.text()) : [];

  return json({ ok: true, conversation: { ...meta, messages } }, { cors });
}

async function handleUpdateConversation(request, env, cors, namespace, conversationId) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400, cors });
  }

  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const existing = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (!existing) {
    return json({ error: "not_found" }, { status: 404, cors });
  }

  const meta = JSON.parse(await existing.text());
  const updated = { ...meta, ...payload, id: conversationId, updatedAt: Date.now() };
  await putObject(env, metaKey, updated);

  return json({ ok: true, conversation: updated }, { cors });
}

async function handleDeleteConversation(env, cors, namespace, conversationId) {
  const prefix = `${namespace}/conversations/${conversationId}/`;

  // List and delete all objects under this conversation
  const listed = await env.CEDAR_SYNC_BUCKET.list({ prefix });
  const keys = listed.objects.map(obj => obj.key);

  if (keys.length > 0) {
    // R2 supports batch delete up to 1000 keys
    await env.CEDAR_SYNC_BUCKET.delete(keys);
  }

  return json({ ok: true, deletedKeys: keys.length }, { cors });
}

// ─── Messages ────────────────────────────────────────────────────────────────

async function handleGetMessages(env, cors, namespace, conversationId) {
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  if (!obj) {
    return json({ ok: true, messages: [] }, { cors });
  }
  const messages = JSON.parse(await obj.text());
  return json({ ok: true, messages }, { cors });
}

async function handleDeleteMessage(env, cors, namespace, conversationId, messageId) {
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  if (!obj) {
    return json({ error: "conversation_not_found" }, { status: 404, cors });
  }

  const messages = JSON.parse(await obj.text());
  const filtered = messages.filter(m => m.id !== messageId);

  if (filtered.length === messages.length) {
    return json({ error: "message_not_found" }, { status: 404, cors });
  }

  await putObject(env, messagesKey, filtered);

  // Update meta messageCount
  const metaKey = `${namespace}/conversations/${conversationId}/meta.json`;
  const metaObj = await env.CEDAR_SYNC_BUCKET.get(metaKey);
  if (metaObj) {
    const meta = JSON.parse(await metaObj.text());
    meta.messageCount = filtered.length;
    meta.updatedAt = Date.now();
    await putObject(env, metaKey, meta);
  }

  return json({ ok: true, remainingMessages: filtered.length }, { cors });
}

// ─── Persistence Helpers ─────────────────────────────────────────────────────

async function persistMessage(env, namespace, conversationId, message) {
  const messagesKey = `${namespace}/conversations/${conversationId}/messages.json`;
  const obj = await env.CEDAR_SYNC_BUCKET.get(messagesKey);
  const messages = obj ? JSON.parse(await obj.text()) : [];

  // Deduplicate by id
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

// ─── Auth ────────────────────────────────────────────────────────────────────

async function authorizeRequest(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!token) return { ok: false, error: "auth_token_required" };
  if (token.length < 8) return { ok: false, error: "auth_token_too_short" };
  const tokenHash = await sha256Hex(token);
  return { ok: true, namespace: `gw/${tokenHash}` };
}

// ─── CORS ────────────────────────────────────────────────────────────────────

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
    Vary: "Origin",
  });
  if (origin && originAllowed) {
    headers.set("Access-Control-Allow-Origin", allowAll ? "*" : origin);
  }
  return { allowed: originAllowed, headers };
}

function parseAllowedOrigins(raw) {
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}

// ─── Utilities ───────────────────────────────────────────────────────────────

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

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomSuffix() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function json(body, { status = 200, cors = null, extraHeaders = {} } = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (cors) {
    for (const [key, value] of cors.headers) {
      headers.set(key, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// ─── Unused stub for background execution (multi-round) ─────────────────────

async function executeAiStream(env, options, namespace, runKey, runRecord, payload, requestBody) {
  // This is a placeholder for the full multi-round tool execution.
  // In the inline streaming model, the actual work is done in startInlineStream.
  // This function would be used for "fire and forget" mode where
  // the Worker executes MCP tools autonomously across multiple rounds.
  // For now, the first round is handled inline. Multi-round will be added next.
}
