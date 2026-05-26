import type { ProviderConfig } from "../providers";
import type {
  Agent,
  Conversation,
  CurrentSelection,
  McpServerConfig,
  Preferences,
  SyncSettings,
  TtsSettings,
  UserStyleSettings,
} from "./storage";

export interface CedarLocalBackup {
  app: "cedar-chat-local-backup";
  version: 1;
  savedAt: number;
  current: CurrentSelection;
  preferences: Preferences;
  providers: ProviderConfig[];
  mcpServers: McpServerConfig[];
  ttsSettings: TtsSettings;
  syncSettings: SyncSettings;
  // 兼容字段:旧版 backup 只存一个字符串。新版仍保留以便降级,
  // 但 userStyleSettings 才是权威来源。
  userStyle: string;
  userStyleSettings: UserStyleSettings;
  agents: Agent[];
  activeAgentId: string | null;
  conversations: Conversation[];
  activeConversationId: string | null;
}

const DB_NAME = "cedar-chat-local-backup";
const STORE_NAME = "snapshots";
const BACKUP_KEY = "latest";
const SAVE_DELAY_MS = 250;

let saveTimer: number | null = null;
let pendingBackup: CedarLocalBackup | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function openBackupDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error("IndexedDB is not available."));
      return;
    }

    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open local backup."));
  });
}

function runStoreRequest<T>(
  mode: IDBTransactionMode,
  runner: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openBackupDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = runner(transaction.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error("Local backup request failed."));
        transaction.oncomplete = () => db.close();
        transaction.onabort = () => {
          db.close();
          reject(transaction.error ?? new Error("Local backup was aborted."));
        };
      }),
  );
}

function isLocalBackup(value: unknown): value is CedarLocalBackup {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.app === "cedar-chat-local-backup" &&
    record.version === 1 &&
    typeof record.savedAt === "number" &&
    Array.isArray(record.conversations) &&
    Array.isArray(record.agents)
  );
}

export async function loadLocalBackup(): Promise<CedarLocalBackup | null> {
  try {
    const result = await runStoreRequest("readonly", (store) =>
      store.get(BACKUP_KEY),
    );
    if (!isLocalBackup(result)) return null;
    return ensureUserStyleSettings(result);
  } catch (error) {
    console.warn("Could not load local backup.", error);
    return null;
  }
}

// 旧 backup 只有 userStyle 字符串,这里补出 userStyleSettings 以便上层无差别消费。
function ensureUserStyleSettings(backup: CedarLocalBackup): CedarLocalBackup {
  if (backup.userStyleSettings && Array.isArray(backup.userStyleSettings.profiles)) {
    return backup;
  }
  const legacyText = typeof backup.userStyle === "string" ? backup.userStyle : "";
  if (!legacyText.trim()) {
    return {
      ...backup,
      userStyleSettings: { activeProfileId: null, profiles: [] },
    };
  }
  const now = Date.now();
  const profileId = "sty_" + Math.random().toString(36).slice(2, 10);
  return {
    ...backup,
    userStyleSettings: {
      activeProfileId: profileId,
      profiles: [
        {
          id: profileId,
          name: "My style",
          prompt: legacyText,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  };
}

export async function saveLocalBackup(
  backup: CedarLocalBackup,
): Promise<void> {
  try {
    await runStoreRequest("readwrite", (store) =>
      store.put(backup, BACKUP_KEY),
    );
  } catch (error) {
    console.warn("Could not save local backup.", error);
  }
}

export function saveLocalBackupSoon(backup: CedarLocalBackup): void {
  pendingBackup = backup;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const next = pendingBackup;
    pendingBackup = null;
    saveTimer = null;
    if (next) void saveLocalBackup(next);
  }, SAVE_DELAY_MS);
}
