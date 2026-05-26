import type { ProviderConfig } from "../providers";
import type {
  Agent,
  Conversation,
  CurrentSelection,
  McpServerConfig,
  Preferences,
  SyncSettings,
  TtsSettings,
} from "./storage";

export interface CedarSyncSnapshot {
  app: "cedar-chat";
  version: 1;
  exportedAt: string;
  deviceName?: string;
  current: CurrentSelection;
  preferences: Preferences;
  providers: ProviderConfig[];
  mcpServers: McpServerConfig[];
  ttsSettings: TtsSettings;
  agents: Agent[];
  activeAgentId: string | null;
  conversations: Conversation[];
  activeConversationId: string | null;
}

export interface PushSyncResult {
  updatedAt?: string;
  bytes?: number;
}

interface SyncObjectRef {
  key: string;
  hash: string;
}

interface ConversationManifestEntry {
  id: string;
  updatedAt: number;
  meta: SyncObjectRef;
  messages: SyncObjectRef[];
}

interface CedarSyncV2Manifest {
  app: "cedar-chat-sync-v2";
  version: 1;
  updatedAt: string;
  deviceName?: string;
  current: SyncObjectRef;
  preferences: SyncObjectRef;
  providers: SyncObjectRef;
  mcpServers: SyncObjectRef;
  ttsSettings: SyncObjectRef;
  agents: SyncObjectRef[];
  activeAgentId: string | null;
  conversations: ConversationManifestEntry[];
  activeConversationId: string | null;
}

export interface CedarSyncBlobRef {
  id: string;
  mime: string;
  size: number;
  createdAt?: string;
}

export function syncSnapshotDataSignature(snapshot: CedarSyncSnapshot): string {
  return JSON.stringify({
    current: snapshot.current,
    preferences: snapshot.preferences,
    providers: snapshot.providers,
    mcpServers: snapshot.mcpServers,
    ttsSettings: snapshot.ttsSettings,
    agents: snapshot.agents,
    activeAgentId: snapshot.activeAgentId,
    conversations: snapshot.conversations,
    activeConversationId: snapshot.activeConversationId,
  });
}

interface EncryptedSyncEnvelope {
  app: "cedar-chat-sync";
  version: 1;
  encrypted: true;
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  compression?: "gzip";
  salt: string;
  iv: string;
  data: string;
  exportedAt: string;
  deviceName?: string;
}

interface EncryptedSyncObjectEnvelope {
  app: "cedar-chat-sync-object";
  version: 1;
  encrypted: true;
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  compression?: "gzip";
  salt: string;
  iv: string;
  data: string;
  createdAt: string;
}

interface EncryptedBlobEnvelope {
  app: "cedar-chat-blob";
  version: 1;
  encrypted: true;
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  data: string;
  mime: string;
  size: number;
  createdAt: string;
}

const SYNC_KDF_ITERATIONS = 120_000;

function snapshotUrl(endpoint: string): string {
  const url = syncBaseUrl(endpoint);
  url.pathname = `${url.pathname}/snapshot`;
  return url.toString();
}

function syncV2Url(endpoint: string, path: string): string {
  const url = syncBaseUrl(endpoint);
  url.pathname = `${url.pathname}/v2${path}`;
  return url.toString();
}

function syncV2ObjectUrl(endpoint: string, key: string): string {
  const url = new URL(syncV2Url(endpoint, "/object"));
  url.searchParams.set("key", key);
  return url.toString();
}

function blobUrl(endpoint: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{6,160}$/.test(id)) {
    throw new Error("Invalid sync blob id.");
  }
  const url = syncBaseUrl(endpoint);
  url.pathname = `${url.pathname}/blob/${id}`;
  return url.toString();
}

function syncBaseUrl(endpoint: string): URL {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("Sync URL is required.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Sync URL must be a valid HTTPS URL.");
  }

  if (url.protocol !== "https:" && !url.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
    throw new Error("Sync URL must use HTTPS.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/sync/snapshot")) {
    url.pathname = path.slice(0, -"/snapshot".length);
  } else if (path.endsWith("/sync")) {
    url.pathname = path;
  } else if (path.match(/\/sync\/blob\/[A-Za-z0-9_-]+$/)) {
    url.pathname = path.replace(/\/blob\/[A-Za-z0-9_-]+$/, "");
  } else {
    url.pathname = `${path}/sync`;
  }
  return url;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function transformBytes(
  bytes: Uint8Array,
  transformer: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([bytesToArrayBuffer(bytes)])
    .stream()
    .pipeThrough(transformer);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function compressSnapshotBytes(
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; compression?: "gzip" }> {
  if (typeof CompressionStream === "undefined") return { bytes };

  try {
    const compressed = await transformBytes(bytes, new CompressionStream("gzip"));
    return compressed.byteLength < bytes.byteLength
      ? { bytes: compressed, compression: "gzip" }
      : { bytes };
  } catch {
    return { bytes };
  }
}

async function decompressSnapshotBytes(
  bytes: Uint8Array,
  compression: EncryptedSyncEnvelope["compression"],
): Promise<Uint8Array> {
  if (!compression) return bytes;
  if (compression !== "gzip") {
    throw new Error("Cloud copy uses an unsupported compression format.");
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress the cloud copy.");
  }
  return transformBytes(bytes, new DecompressionStream("gzip"));
}

async function deriveSyncKey(
  syncCode: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(syncCode),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: bytesToArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptSnapshot(
  snapshot: CedarSyncSnapshot,
  syncCode: string,
): Promise<EncryptedSyncEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSyncKey(syncCode, salt, SYNC_KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const compressed = await compressSnapshotBytes(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(compressed.bytes),
  );

  return {
    app: "cedar-chat-sync",
    version: 1,
    encrypted: true,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: SYNC_KDF_ITERATIONS,
    ...(compressed.compression ? { compression: compressed.compression } : {}),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
    exportedAt: snapshot.exportedAt,
    ...(snapshot.deviceName ? { deviceName: snapshot.deviceName } : {}),
  };
}

async function encryptSyncObject(
  value: unknown,
  syncCode: string,
): Promise<EncryptedSyncObjectEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSyncKey(syncCode, salt, SYNC_KDF_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const compressed = await compressSnapshotBytes(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(compressed.bytes),
  );

  return {
    app: "cedar-chat-sync-object",
    version: 1,
    encrypted: true,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: SYNC_KDF_ITERATIONS,
    ...(compressed.compression ? { compression: compressed.compression } : {}),
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
    createdAt: new Date().toISOString(),
  };
}

async function encryptBlob(
  blob: Blob,
  syncCode: string,
): Promise<EncryptedBlobEnvelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveSyncKey(syncCode, salt, SYNC_KDF_ITERATIONS);
  const plaintext = new Uint8Array(await blob.arrayBuffer());
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
    key,
    bytesToArrayBuffer(plaintext),
  );

  return {
    app: "cedar-chat-blob",
    version: 1,
    encrypted: true,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: SYNC_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
    mime: blob.type || "application/octet-stream",
    size: blob.size,
    createdAt: new Date().toISOString(),
  };
}

function isEncryptedEnvelope(value: unknown): value is EncryptedSyncEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.app === "cedar-chat-sync" &&
    record.version === 1 &&
    record.encrypted === true &&
    record.algorithm === "AES-GCM" &&
    record.kdf === "PBKDF2-SHA256" &&
    typeof record.iterations === "number" &&
    typeof record.salt === "string" &&
    typeof record.iv === "string" &&
    typeof record.data === "string"
  );
}

function isEncryptedSyncObjectEnvelope(
  value: unknown,
): value is EncryptedSyncObjectEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.app === "cedar-chat-sync-object" &&
    record.version === 1 &&
    record.encrypted === true &&
    record.algorithm === "AES-GCM" &&
    record.kdf === "PBKDF2-SHA256" &&
    typeof record.iterations === "number" &&
    typeof record.salt === "string" &&
    typeof record.iv === "string" &&
    typeof record.data === "string"
  );
}

function isEncryptedBlobEnvelope(value: unknown): value is EncryptedBlobEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.app === "cedar-chat-blob" &&
    record.version === 1 &&
    record.encrypted === true &&
    record.algorithm === "AES-GCM" &&
    record.kdf === "PBKDF2-SHA256" &&
    typeof record.iterations === "number" &&
    typeof record.salt === "string" &&
    typeof record.iv === "string" &&
    typeof record.data === "string" &&
    typeof record.mime === "string" &&
    typeof record.size === "number" &&
    typeof record.createdAt === "string"
  );
}

async function decryptSnapshot(
  envelope: EncryptedSyncEnvelope,
  syncCode: string,
): Promise<CedarSyncSnapshot> {
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const data = base64ToBytes(envelope.data);
    const key = await deriveSyncKey(syncCode, salt, envelope.iterations);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
      key,
      bytesToArrayBuffer(data),
    );
    const plaintext = await decompressSnapshotBytes(
      new Uint8Array(decrypted),
      envelope.compression,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as CedarSyncSnapshot;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("compression") ||
        error.message.includes("decompress"))
    ) {
      throw error;
    }
    throw new Error("Could not decrypt cloud copy. Check the sync code.");
  }
}

async function decryptSyncObject<T>(
  envelope: EncryptedSyncObjectEnvelope,
  syncCode: string,
): Promise<T> {
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const data = base64ToBytes(envelope.data);
    const key = await deriveSyncKey(syncCode, salt, envelope.iterations);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
      key,
      bytesToArrayBuffer(data),
    );
    const plaintext = await decompressSnapshotBytes(
      new Uint8Array(decrypted),
      envelope.compression,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("compression") ||
        error.message.includes("decompress"))
    ) {
      throw error;
    }
    throw new Error("Could not decrypt cloud object. Check the sync code.");
  }
}

async function decryptBlob(
  envelope: EncryptedBlobEnvelope,
  syncCode: string,
): Promise<Blob> {
  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const data = base64ToBytes(envelope.data);
    const key = await deriveSyncKey(syncCode, salt, envelope.iterations);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesToArrayBuffer(iv) },
      key,
      bytesToArrayBuffer(data),
    );
    return new Blob([decrypted], { type: envelope.mime });
  } catch {
    throw new Error("Could not decrypt audio. Check the sync code.");
  }
}

function authHeaders(settings: SyncSettings): Record<string, string> {
  const syncCode = settings.syncCode.trim();
  if (syncCode.length < 8) {
    throw new Error("Sync code needs at least 8 characters.");
  }

  return {
    Authorization: `Bearer ${syncCode}`,
  };
}

async function responseError(response: Response): Promise<Error> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return new Error(parsed.message || parsed.error || `HTTP ${response.status}`);
  } catch {
    return new Error(text || `HTTP ${response.status}`);
  }
}

async function incrementalSyncAvailable(
  settings: SyncSettings,
): Promise<boolean> {
  try {
    const response = await fetch(syncV2Url(settings.endpoint, "/health"), {
      method: "GET",
      headers: {
        ...authHeaders(settings),
        Accept: "application/json",
      },
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; version?: number }
      | null;
    return payload?.ok === true && payload.version === 2;
  } catch {
    return false;
  }
}

async function pullEncryptedSyncObject<T>(
  settings: SyncSettings,
  ref: SyncObjectRef,
): Promise<T> {
  const response = await fetch(syncV2ObjectUrl(settings.endpoint, ref.key), {
    method: "GET",
    headers: {
      ...authHeaders(settings),
      Accept: "application/json",
    },
  });
  if (!response.ok) throw await responseError(response);

  const payload = (await response.json()) as unknown;
  if (!isEncryptedSyncObjectEnvelope(payload)) {
    throw new Error(`Cloud object ${ref.key} has an unknown format.`);
  }
  return decryptSyncObject<T>(payload, settings.syncCode.trim());
}

async function pullIncrementalManifest(
  settings: SyncSettings,
): Promise<CedarSyncV2Manifest | null> {
  const response = await fetch(syncV2Url(settings.endpoint, "/manifest"), {
    method: "GET",
    headers: {
      ...authHeaders(settings),
      Accept: "application/json",
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response);

  const payload = (await response.json()) as unknown;
  if (!isEncryptedSyncObjectEnvelope(payload)) {
    throw new Error("Cloud manifest has an unknown format.");
  }
  return decryptSyncObject<CedarSyncV2Manifest>(
    payload,
    settings.syncCode.trim(),
  );
}

async function pushEncryptedSyncObject(
  settings: SyncSettings,
  key: string,
  value: unknown,
): Promise<number> {
  const envelope = await encryptSyncObject(value, settings.syncCode.trim());
  const body = JSON.stringify(envelope);
  const response = await fetch(syncV2ObjectUrl(settings.endpoint, key), {
    method: "PUT",
    headers: {
      ...authHeaders(settings),
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) throw await responseError(response);
  return new TextEncoder().encode(body).byteLength;
}

async function pushIncrementalManifest(
  settings: SyncSettings,
  manifest: CedarSyncV2Manifest,
): Promise<number> {
  const envelope = await encryptSyncObject(manifest, settings.syncCode.trim());
  const body = JSON.stringify(envelope);
  const response = await fetch(syncV2Url(settings.endpoint, "/manifest"), {
    method: "PUT",
    headers: {
      ...authHeaders(settings),
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) throw await responseError(response);
  return new TextEncoder().encode(body).byteLength;
}

function syncObject<T>(key: string, value: T): { key: string; value: T } {
  return { key, value };
}

async function objectRef(
  item: { key: string; value: unknown },
): Promise<SyncObjectRef> {
  return {
    key: item.key,
    hash: await sha256Hex(JSON.stringify(item.value)),
  };
}

function sameRef(
  a: SyncObjectRef | undefined,
  b: SyncObjectRef | undefined,
): boolean {
  return Boolean(a && b && a.key === b.key && a.hash === b.hash);
}

async function buildIncrementalManifestAndObjects(
  snapshot: CedarSyncSnapshot,
): Promise<{
  manifest: CedarSyncV2Manifest;
  objects: Array<{ key: string; value: unknown; ref: SyncObjectRef }>;
}> {
  const baseObjects = [
    syncObject("state/current.json", snapshot.current),
    syncObject("state/preferences.json", snapshot.preferences),
    syncObject("state/providers.json", snapshot.providers),
    syncObject("state/mcpServers.json", snapshot.mcpServers),
    syncObject("state/ttsSettings.json", snapshot.ttsSettings),
  ];
  const agentObjects = snapshot.agents.map((agent) =>
    syncObject(`agents/${agent.id}.json`, agent),
  );
  const conversationMetaObjects = snapshot.conversations.map((conversation) =>
    syncObject(`conversations/${conversation.id}/meta.json`, {
      ...conversation,
      messages: [],
    }),
  );
  const messageObjects = snapshot.conversations.flatMap((conversation) =>
    conversation.messages.map((message) =>
      syncObject(
        `conversations/${conversation.id}/messages/${message.id}.json`,
        message,
      ),
    ),
  );
  const objectValues = [
    ...baseObjects,
    ...agentObjects,
    ...conversationMetaObjects,
    ...messageObjects,
  ];
  const refs = await Promise.all(objectValues.map(objectRef));
  const objects = objectValues.map((object, index) => ({
    ...object,
    ref: refs[index],
  }));
  const refByKey = new Map(objects.map((object) => [object.key, object.ref]));
  const requireRef = (key: string): SyncObjectRef => {
    const ref = refByKey.get(key);
    if (!ref) throw new Error(`Missing sync object ref for ${key}.`);
    return ref;
  };

  return {
    manifest: {
      app: "cedar-chat-sync-v2",
      version: 1,
      updatedAt: snapshot.exportedAt,
      ...(snapshot.deviceName ? { deviceName: snapshot.deviceName } : {}),
      current: requireRef("state/current.json"),
      preferences: requireRef("state/preferences.json"),
      providers: requireRef("state/providers.json"),
      mcpServers: requireRef("state/mcpServers.json"),
      ttsSettings: requireRef("state/ttsSettings.json"),
      agents: snapshot.agents.map((agent) => requireRef(`agents/${agent.id}.json`)),
      activeAgentId: snapshot.activeAgentId,
      conversations: snapshot.conversations.map((conversation) => ({
        id: conversation.id,
        updatedAt: conversation.updatedAt,
        meta: requireRef(`conversations/${conversation.id}/meta.json`),
        messages: conversation.messages.map((message) =>
          requireRef(
            `conversations/${conversation.id}/messages/${message.id}.json`,
          ),
        ),
      })),
      activeConversationId: snapshot.activeConversationId,
    },
    objects,
  };
}

async function pushIncrementalSyncSnapshot(
  settings: SyncSettings,
  snapshot: CedarSyncSnapshot,
): Promise<PushSyncResult> {
  const previousManifest = await pullIncrementalManifest(settings);
  const { manifest, objects } = await buildIncrementalManifestAndObjects(snapshot);
  const previousRefs = new Map<string, SyncObjectRef>();
  if (previousManifest) {
    for (const ref of [
      previousManifest.current,
      previousManifest.preferences,
      previousManifest.providers,
      previousManifest.mcpServers,
      previousManifest.ttsSettings,
      ...previousManifest.agents,
    ]) {
      previousRefs.set(ref.key, ref);
    }
    for (const conversation of previousManifest.conversations) {
      previousRefs.set(conversation.meta.key, conversation.meta);
      for (const ref of conversation.messages) previousRefs.set(ref.key, ref);
    }
  }

  let bytes = 0;
  for (const object of objects) {
    if (sameRef(previousRefs.get(object.key), object.ref)) continue;
    bytes += await pushEncryptedSyncObject(settings, object.key, object.value);
  }
  bytes += await pushIncrementalManifest(settings, manifest);

  return {
    updatedAt: manifest.updatedAt,
    bytes,
  };
}

async function pullIncrementalSyncSnapshot(
  settings: SyncSettings,
): Promise<CedarSyncSnapshot | null> {
  const manifest = await pullIncrementalManifest(settings);
  if (!manifest) return null;

  const [
    current,
    preferences,
    providers,
    mcpServers,
    ttsSettings,
    agents,
    conversations,
  ] = await Promise.all([
    pullEncryptedSyncObject<CurrentSelection>(settings, manifest.current),
    pullEncryptedSyncObject<Preferences>(settings, manifest.preferences),
    pullEncryptedSyncObject<ProviderConfig[]>(settings, manifest.providers),
    pullEncryptedSyncObject<McpServerConfig[]>(settings, manifest.mcpServers),
    pullEncryptedSyncObject<TtsSettings>(settings, manifest.ttsSettings),
    Promise.all(
      manifest.agents.map((ref) => pullEncryptedSyncObject<Agent>(settings, ref)),
    ),
    Promise.all(
      manifest.conversations.map(async (entry) => {
        const meta = await pullEncryptedSyncObject<Conversation>(
          settings,
          entry.meta,
        );
        const messages = await Promise.all(
          entry.messages.map((ref) =>
            pullEncryptedSyncObject<Conversation["messages"][number]>(
              settings,
              ref,
            ),
          ),
        );
        return { ...meta, messages };
      }),
    ),
  ]);

  return {
    app: "cedar-chat",
    version: 1,
    exportedAt: manifest.updatedAt,
    ...(manifest.deviceName ? { deviceName: manifest.deviceName } : {}),
    current,
    preferences,
    providers,
    mcpServers,
    ttsSettings,
    agents,
    activeAgentId: manifest.activeAgentId,
    conversations,
    activeConversationId: manifest.activeConversationId,
  };
}

export async function pushSyncSnapshot(
  settings: SyncSettings,
  snapshot: CedarSyncSnapshot,
): Promise<PushSyncResult> {
  if (await incrementalSyncAvailable(settings)) {
    return pushIncrementalSyncSnapshot(settings, snapshot);
  }

  const syncCode = settings.syncCode.trim();
  const envelope = await encryptSnapshot(snapshot, syncCode);
  const body = JSON.stringify(envelope);
  let response: Response;

  try {
    response = await fetch(snapshotUrl(settings.endpoint), {
      method: "POST",
      headers: {
        ...authHeaders(settings),
        "Content-Type": "application/json",
      },
      body,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Sync upload failed: ${message}`);
  }

  if (!response.ok) throw await responseError(response);

  const parsed = (await response.json().catch(() => ({}))) as PushSyncResult;
  return {
    updatedAt:
      parsed.updatedAt ??
      response.headers.get("X-Cedar-Sync-Updated-At") ??
      undefined,
    bytes: parsed.bytes,
  };
}

export async function pullSyncSnapshot(
  settings: SyncSettings,
): Promise<CedarSyncSnapshot | null> {
  if (await incrementalSyncAvailable(settings)) {
    const incrementalSnapshot = await pullIncrementalSyncSnapshot(settings);
    if (incrementalSnapshot) return incrementalSnapshot;
  }

  let response: Response;

  try {
    response = await fetch(snapshotUrl(settings.endpoint), {
      method: "GET",
      headers: {
        ...authHeaders(settings),
        Accept: "application/json",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Sync download failed: ${message}`);
  }

  if (response.status === 404) return null;
  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as unknown;
  if (isEncryptedEnvelope(payload)) {
    return decryptSnapshot(payload, settings.syncCode.trim());
  }
  return payload as CedarSyncSnapshot;
}

export async function pushSyncBlob(
  settings: SyncSettings,
  id: string,
  blob: Blob,
): Promise<CedarSyncBlobRef> {
  const envelope = await encryptBlob(blob, settings.syncCode.trim());
  const body = JSON.stringify(envelope);
  let response: Response;

  try {
    response = await fetch(blobUrl(settings.endpoint, id), {
      method: "PUT",
      headers: {
        ...authHeaders(settings),
        "Content-Type": "application/json",
      },
      body,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio upload failed: ${message}`);
  }

  if (!response.ok) throw await responseError(response);

  return {
    id,
    mime: envelope.mime,
    size: envelope.size,
    createdAt: envelope.createdAt,
  };
}

export async function pullSyncBlob(
  settings: SyncSettings,
  ref: CedarSyncBlobRef,
): Promise<Blob> {
  let response: Response;

  try {
    response = await fetch(blobUrl(settings.endpoint, ref.id), {
      method: "GET",
      headers: {
        ...authHeaders(settings),
        Accept: "application/json, application/octet-stream",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio download failed: ${message}`);
  }

  if (!response.ok) throw await responseError(response);

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as unknown;
    if (isEncryptedBlobEnvelope(payload)) {
      return decryptBlob(payload, settings.syncCode.trim());
    }
    throw new Error("Audio blob has an unknown format.");
  }

  return response.blob();
}
