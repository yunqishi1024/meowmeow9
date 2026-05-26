import type { McpServerConfig } from "./storage";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface McpToolSummary {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTestResult {
  serverInfo?: string;
  protocolVersion?: string;
  tools: McpToolSummary[];
}

export interface McpToolListResult {
  serverInfo?: string;
  protocolVersion?: string;
  sessionId?: string;
  tools: McpToolSummary[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSsePayload(text: string, requestId?: number): JsonRpcResponse {
  const events = text.split(/\r?\n\r?\n+/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""))
      .join("\n")
      .trim();
    if (!data) continue;

    const parsed = JSON.parse(data) as JsonRpcResponse;
    if (requestId === undefined || parsed.id === requestId) return parsed;
  }
  throw new Error("MCP server returned an SSE stream without a JSON-RPC result.");
}

async function readJsonRpcResponse(
  response: Response,
  requestId?: number,
): Promise<JsonRpcResponse | null> {
  if (response.status === 202 || response.status === 204) return null;

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!text.trim()) return null;

  if (contentType.includes("text/event-stream")) {
    return parseSsePayload(text, requestId);
  }
  return JSON.parse(text) as JsonRpcResponse;
}

async function postMcp(
  server: McpServerConfig,
  payload: JsonRpcRequest,
  sessionId?: string,
): Promise<{ response: JsonRpcResponse | null; sessionId?: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
  };

  if (server.bearerToken.trim()) {
    headers.Authorization = `Bearer ${server.bearerToken.trim()}`;
  }
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  let httpResponse: Response;
  try {
    httpResponse = await fetch(server.url.trim(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Network/CORS error: ${message}`,
        "Check that the URL is reachable from this browser, the server allows CORS for POST/OPTIONS, and the endpoint supports MCP Streamable HTTP.",
        "If Cedar Chat is loaded over HTTPS, the MCP URL usually also needs HTTPS.",
        "If the URL uses localhost, remember it means this device, not another computer.",
      ].join(" "),
    );
  }

  if (!httpResponse.ok) {
    const text = await httpResponse.text().catch(() => "");
    throw new Error(
      `HTTP ${httpResponse.status}: ${text.slice(0, 300) || httpResponse.statusText}`,
    );
  }

  const nextSessionId =
    httpResponse.headers.get("Mcp-Session-Id") ??
    httpResponse.headers.get("mcp-session-id") ??
    sessionId;
  const response = await readJsonRpcResponse(httpResponse, payload.id);
  if (response?.error) {
    throw new Error(
      response.error.message ??
        `MCP error ${response.error.code ?? "unknown"}`,
    );
  }

  return { response, sessionId: nextSessionId };
}

function parseServerInfo(result: unknown): string | undefined {
  const root = asRecord(result);
  const info = asRecord(root.serverInfo);
  const name = asString(info.name);
  const version = asString(info.version);
  if (!name && !version) return undefined;
  return [name, version].filter(Boolean).join(" ");
}

function parseProtocolVersion(result: unknown): string | undefined {
  return asString(asRecord(result).protocolVersion);
}

function parseTools(result: unknown): McpToolSummary[] {
  const tools = asRecord(result).tools;
  if (!Array.isArray(tools)) return [];

  const parsed: McpToolSummary[] = [];
  for (const tool of tools) {
    const record = asRecord(tool);
    const name = asString(record.name);
    if (!name) continue;
    const description = asString(record.description);
    const inputSchema = asRecord(record.inputSchema);
    parsed.push({
      name,
      ...(description ? { description } : {}),
      ...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
    });
  }
  return parsed;
}

async function initializeMcpServer(
  server: McpServerConfig,
): Promise<{
  response: JsonRpcResponse | null;
  sessionId?: string;
}> {
  if (!server.url.trim()) throw new Error("MCP URL is required.");

  const initialize = await postMcp(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "cedar-chat",
        version: "0.1.0",
      },
    },
  });

  await postMcp(
    server,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    initialize.sessionId,
  );

  return initialize;
}

export async function listMcpServerTools(
  server: McpServerConfig,
): Promise<McpToolListResult> {
  const initialize = await initializeMcpServer(server);

  const tools = await postMcp(
    server,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    initialize.sessionId,
  );

  return {
    serverInfo: parseServerInfo(initialize.response?.result),
    protocolVersion: parseProtocolVersion(initialize.response?.result),
    sessionId: initialize.sessionId,
    tools: parseTools(tools.response?.result),
  };
}

export async function callMcpTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
  sessionId?: string,
): Promise<{ result: unknown; sessionId?: string }> {
  const call = await postMcp(
    server,
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    },
    sessionId,
  );

  return {
    result: call.response?.result ?? null,
    sessionId: call.sessionId,
  };
}

export async function testMcpServer(
  server: McpServerConfig,
): Promise<McpTestResult> {
  const result = await listMcpServerTools(server);
  return {
    serverInfo: result.serverInfo,
    protocolVersion: result.protocolVersion,
    tools: result.tools,
  };
}
