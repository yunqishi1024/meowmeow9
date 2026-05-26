// Provider 设置抽屉
// - 左侧：已配置的 provider 列表
// - 右侧：当前编辑的 provider 表单
// - 可以新增 / 编辑 / 删除

import { useState } from "react";
import type { ProviderConfig, ProviderKind } from "../providers";
import {
  createTtsProfile,
  createUserStyleProfile,
  getActiveTtsProfile,
  newMcpServerId,
  newProviderId,
  type McpServerConfig,
  type Preferences,
  type SyncSettings,
  type TtsProfile,
  type TtsProviderKind,
  type TtsSettings,
  type UserStyleProfile,
  type UserStyleSettings,
} from "../lib/storage";
import { testMcpServer, type McpTestResult } from "../lib/mcp";
import { playTts } from "../lib/tts";

interface Props {
  open: boolean;
  activeTab: SettingsTab;
  providers: ProviderConfig[];
  preferences: Preferences;
  mcpServers: McpServerConfig[];
  ttsSettings: TtsSettings;
  syncSettings: SyncSettings;
  syncBusy: boolean;
  syncStatus: string | null;
  userStyle: string;
  userStyleSettings: UserStyleSettings;
  onClose: () => void;
  onChange: (providers: ProviderConfig[]) => void;
  onActiveTabChange: (tab: SettingsTab) => void;
  onPreferencesChange: (prefs: Preferences) => void;
  onMcpServersChange: (servers: McpServerConfig[]) => void;
  onTtsSettingsChange: (settings: TtsSettings) => void;
  onSyncSettingsChange: (settings: SyncSettings) => void;
  onSyncPush: () => void;
  onSyncPull: () => void;
  onUserStyleSettingsChange: (settings: UserStyleSettings) => void;
}

export type SettingsTab = "providers" | "preferences" | "mcp" | "tts" | "sync";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "providers", label: "Providers" },
  { id: "preferences", label: "Preferences" },
  { id: "tts", label: "语音" },
  { id: "sync", label: "同步" },
  { id: "mcp", label: "MCP" },
];

function emptyConfig(): ProviderConfig {
  return {
    id: newProviderId(),
    name: "",
    kind: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    models: [],
  };
}

export function Settings({
  open,
  activeTab,
  providers,
  preferences,
  mcpServers,
  ttsSettings,
  syncSettings,
  syncBusy,
  syncStatus,
  userStyleSettings,
  onClose,
  onChange,
  onActiveTabChange,
  onPreferencesChange,
  onMcpServersChange,
  onTtsSettingsChange,
  onSyncSettingsChange,
  onSyncPush,
  onSyncPull,
  onUserStyleSettingsChange,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const [modelsText, setModelsText] = useState("");

  if (!open) return null;

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setDraft({ ...p });
    setModelsText(p.models.join("\n"));
  }

  function startNew() {
    const fresh = emptyConfig();
    setEditingId(fresh.id);
    setDraft(fresh);
    setModelsText("");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setModelsText("");
  }

  function saveDraft() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      alert("Name and Base URL are required");
      return;
    }
    const models = modelsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const finalDraft = { ...draft, models };

    const exists = providers.some((p) => p.id === finalDraft.id);
    const next = exists
      ? providers.map((p) => (p.id === finalDraft.id ? finalDraft : p))
      : [...providers, finalDraft];
    onChange(next);
    cancelEdit();
  }

  function deleteProvider(id: string) {
    if (!confirm("Delete this provider?")) return;
    onChange(providers.filter((p) => p.id !== id));
    if (editingId === id) cancelEdit();
  }

  const draftExists = draft ? providers.some((p) => p.id === draft.id) : false;

  return (
    <div className="cedar-settings-overlay" role="dialog" aria-modal="true">
      <button
        type="button"
        className="cedar-settings-shade"
        onClick={onClose}
        aria-label="Close settings"
      />

      <div className="cedar-settings-drawer">
        <header className="cedar-settings-header">
          <nav className="cedar-settings-tabbar" aria-label="Settings sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onActiveTabChange(tab.id)}
                className={`cedar-settings-tab${activeTab === tab.id ? " active" : ""}`}
                aria-current={activeTab === tab.id ? "page" : undefined}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={onClose}
            className="cedar-settings-close"
            aria-label="Close settings"
          >
            Close ✕
          </button>
        </header>

        {activeTab === "preferences" ? (
          <PreferencesPanel
            preferences={preferences}
            userStyleSettings={userStyleSettings}
            providers={providers}
            onChange={onPreferencesChange}
            onUserStyleSettingsChange={onUserStyleSettingsChange}
          />
        ) : activeTab === "tts" ? (
          <TtsPanel settings={ttsSettings} onChange={onTtsSettingsChange} />
        ) : activeTab === "sync" ? (
          <SyncPanel
            settings={syncSettings}
            busy={syncBusy}
            status={syncStatus}
            onChange={onSyncSettingsChange}
            onPush={onSyncPush}
            onPull={onSyncPull}
          />
        ) : activeTab === "mcp" ? (
          <McpPanel servers={mcpServers} onChange={onMcpServersChange} />
        ) : (
          <div className="cedar-settings-body">
            {/* 左侧 provider 列表 */}
            <aside className="cedar-settings-aside">
              <div className="cedar-settings-aside-section">
                <ul className="cedar-settings-list">
                  {providers.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        className={`cedar-settings-list-item${editingId === p.id ? " active" : ""}`}
                      >
                        <span className="cedar-settings-list-name">
                          {p.name || "(unnamed)"}
                        </span>
                        <span className="cedar-settings-list-sub">{p.baseUrl}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={startNew}
                  className="cedar-settings-list-add"
                >
                  + Add Provider
                </button>
              </div>
            </aside>

            {/* 右侧表单 */}
            <section className="cedar-settings-content">
              <div className="cedar-settings-scroll">
                {!draft ? (
                  <div className="cedar-section-head">
                    <div className="cedar-section-title">No provider selected</div>
                    <div className="cedar-section-desc">
                      Select a provider on the left, or add a new one.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="cedar-section-head">
                      <div className="cedar-section-title">
                        {draftExists ? "Edit provider" : "New provider"}
                      </div>
                      <div className="cedar-section-desc">
                        Configure an OpenAI-compatible upstream that this app will
                        call. API keys live only in your browser.
                      </div>
                    </div>

                    <Field label="Name">
                      <input
                        className="input"
                        placeholder="e.g. OpenRouter"
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                      />
                    </Field>

                    <Field label="Kind">
                      <select
                        className="select"
                        value={draft.kind}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            kind: e.target.value as ProviderKind,
                          })
                        }
                      >
                        <option value="openai-compatible">OpenAI-compatible</option>
                        <option value="anthropic" disabled>
                          Anthropic (native, coming soon)
                        </option>
                      </select>
                    </Field>

                    <Field
                      label="Base URL"
                      hint={
                        <>
                          Should end with <code>/v1</code> (the endpoint will be{" "}
                          <code>&lt;base&gt;/chat/completions</code>).
                        </>
                      }
                    >
                      <input
                        className="input"
                        placeholder="https://openrouter.ai/api/v1"
                        value={draft.baseUrl}
                        onChange={(e) =>
                          setDraft({ ...draft, baseUrl: e.target.value })
                        }
                      />
                    </Field>

                    <Field
                      label="API Key"
                      hint="Stored in your browser only. Never leaves your device except to call the provider you configure."
                    >
                      <input
                        className="input"
                        type="password"
                        placeholder="sk-..."
                        value={draft.apiKey}
                        onChange={(e) =>
                          setDraft({ ...draft, apiKey: e.target.value })
                        }
                      />
                    </Field>

                    <Field label="Models (one per line)">
                      <textarea
                        className="input font-mono"
                        rows={8}
                        placeholder={"anthropic/claude-opus-4-7\nanthropic/claude-opus-4-6"}
                        value={modelsText}
                        onChange={(e) => setModelsText(e.target.value)}
                      />
                    </Field>

                    <div className="cedar-settings-footer-spacer" />
                  </>
                )}
              </div>

              {draft && (
                <div className="cedar-settings-footer">
                  <button
                    type="button"
                    onClick={saveDraft}
                    className="cedar-btn-primary"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="cedar-btn-secondary"
                  >
                    Cancel
                  </button>
                  {draftExists && (
                    <button
                      type="button"
                      onClick={() => deleteProvider(draft.id)}
                      className="cedar-btn-danger"
                      style={{ marginLeft: "auto" }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function emptyMcpServer(): McpServerConfig {
  return {
    id: newMcpServerId(),
    name: "",
    url: "",
    bearerToken: "",
    enabled: true,
  };
}

function McpPanel({
  servers,
  onChange,
}: {
  servers: McpServerConfig[];
  onChange: (servers: McpServerConfig[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  function startEdit(server: McpServerConfig) {
    setEditingId(server.id);
    setDraft({ ...server });
    setTestError(null);
    setTestResult(null);
  }

  function startNew() {
    const fresh = emptyMcpServer();
    setEditingId(fresh.id);
    setDraft(fresh);
    setTestError(null);
    setTestResult(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setTestError(null);
    setTestResult(null);
  }

  function saveDraft() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.url.trim()) {
      alert("Name and URL are required");
      return;
    }

    const exists = servers.some((server) => server.id === draft.id);
    const next = exists
      ? servers.map((server) => (server.id === draft.id ? draft : server))
      : [...servers, draft];
    onChange(next);
    cancelEdit();
  }

  function deleteServer(id: string) {
    if (!confirm("Delete this MCP server?")) return;
    onChange(servers.filter((server) => server.id !== id));
    if (editingId === id) cancelEdit();
  }

  async function testDraft() {
    if (!draft) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await testMcpServer(draft);
      setTestResult(result);
    } catch (error: unknown) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  const draftExists = draft ? servers.some((s) => s.id === draft.id) : false;

  return (
    <div className="cedar-settings-body">
      <aside className="cedar-settings-aside">
        <div className="cedar-settings-aside-section">
          <ul className="cedar-settings-list">
            {servers.map((server) => (
              <li key={server.id}>
                <button
                  type="button"
                  onClick={() => startEdit(server)}
                  className={`cedar-settings-list-item${editingId === server.id ? " active" : ""}`}
                >
                  <span className="cedar-settings-list-name">
                    {server.name || "(unnamed)"}
                  </span>
                  <span className="cedar-settings-list-sub">{server.url}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={startNew}
            className="cedar-settings-list-add"
          >
            + Add MCP server
          </button>
        </div>
      </aside>

      <section className="cedar-settings-content">
        <div className="cedar-settings-scroll">
          {!draft ? (
            <div className="cedar-section-head">
              <div className="cedar-section-title">No server selected</div>
              <div className="cedar-section-desc">
                Select an MCP server on the left, or add a remote HTTP MCP server.
              </div>
            </div>
          ) : (
            <>
              <div className="cedar-section-head">
                <div className="cedar-section-title">
                  {draftExists ? "Edit MCP server" : "New MCP server"}
                </div>
                <div className="cedar-section-desc">
                  Connect a remote Streamable-HTTP MCP server. Tools exposed by
                  the server will be available to the assistant when enabled.
                </div>
              </div>

              <Field label="Name">
                <input
                  className="input"
                  placeholder="e.g. My MCP server"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </Field>

              <Field
                label="Streamable HTTP URL"
                hint="Browser access requires the MCP server to allow CORS."
              >
                <input
                  className="input"
                  placeholder="https://example.com/mcp"
                  value={draft.url}
                  onChange={(event) =>
                    setDraft({ ...draft, url: event.target.value })
                  }
                />
              </Field>

              <Field label="Bearer Token">
                <input
                  className="input"
                  type="password"
                  placeholder="optional"
                  value={draft.bearerToken}
                  onChange={(event) =>
                    setDraft({ ...draft, bearerToken: event.target.value })
                  }
                />
              </Field>

              <label className="cedar-inline-checkbox">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) =>
                    setDraft({ ...draft, enabled: event.target.checked })
                  }
                />
                Enabled
              </label>

              {testError && (
                <div className="cedar-notice error">
                  <div className="cedar-notice-title">Test failed</div>
                  <div className="cedar-notice-sub">{testError}</div>
                </div>
              )}

              {testResult && (
                <div className="cedar-notice success">
                  <div className="cedar-notice-title">Connected</div>
                  <div className="cedar-notice-sub">
                    {testResult.serverInfo || "MCP server"}
                    {testResult.protocolVersion
                      ? ` · protocol ${testResult.protocolVersion}`
                      : ""}
                  </div>
                  <div className="cedar-notice-section-title">Tools</div>
                  {testResult.tools.length === 0 ? (
                    <div className="cedar-notice-sub">No tools returned.</div>
                  ) : (
                    <ul className="cedar-tool-list">
                      {testResult.tools.map((tool) => (
                        <li key={tool.name}>
                          <div className="tool-name">{tool.name}</div>
                          {tool.description && (
                            <div className="tool-desc">{tool.description}</div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="cedar-settings-footer-spacer" />
            </>
          )}
        </div>

        {draft && (
          <div className="cedar-settings-footer">
            <button
              type="button"
              onClick={saveDraft}
              className="cedar-btn-primary"
            >
              Save
            </button>
            <button
              type="button"
              onClick={testDraft}
              disabled={testing || !draft.url.trim()}
              className="cedar-btn-secondary"
            >
              {testing ? "Testing..." : "Test"}
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="cedar-btn-ghost"
            >
              Cancel
            </button>
            {draftExists && (
              <button
                type="button"
                onClick={() => deleteServer(draft.id)}
                className="cedar-btn-danger"
                style={{ marginLeft: "auto" }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TtsPanel({
  settings,
  onChange,
}: {
  settings: TtsSettings;
  onChange: (settings: TtsSettings) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const activeProfile = getActiveTtsProfile(settings);

  function patchSettings(next: Partial<TtsSettings>) {
    onChange({ ...settings, ...next });
  }

  function updateProfile(patch: Partial<TtsProfile>) {
    if (!activeProfile) return;
    onChange({
      ...settings,
      profiles: settings.profiles.map((profile) =>
        profile.id === activeProfile.id ? { ...profile, ...patch } : profile,
      ),
    });
  }

  function addProfile() {
    const profile = createTtsProfile({
      name: `Voice ${settings.profiles.length + 1}`,
    });
    onChange({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.id,
    });
    setTestError(null);
  }

  function deleteProfile(id: string) {
    if (!confirm("Delete this voice profile?")) return;
    const nextProfiles = settings.profiles.filter((profile) => profile.id !== id);
    onChange({
      ...settings,
      profiles: nextProfiles,
      activeProfileId:
        settings.activeProfileId === id
          ? (nextProfiles[0]?.id ?? null)
          : settings.activeProfileId,
    });
    setTestError(null);
  }

  async function testVoice() {
    if (!activeProfile) {
      setTestError("Add or select a voice profile first.");
      return;
    }
    setTesting(true);
    setTestError(null);
    try {
      await playTts(activeProfile, "Cedar Chat voice test.");
    } catch (error: unknown) {
      setTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }

  const providerLabel =
    activeProfile?.provider === "elevenlabs"
      ? "ElevenLabs"
      : activeProfile?.provider === "minimax"
        ? "MiniMax"
        : activeProfile?.provider === "azure"
          ? "Azure Speech"
          : "Edge";

  return (
    <div className="cedar-settings-body">
      <aside className="cedar-settings-aside">
        <div className="cedar-settings-aside-section">
          <label className="cedar-inline-checkbox" style={{ justifyContent: "space-between", width: "100%" }}>
            <span style={{ fontWeight: 500 }}>Enable voice playback</span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) =>
                patchSettings({ enabled: event.target.checked })
              }
            />
          </label>
          <button
            type="button"
            onClick={addProfile}
            className="cedar-settings-list-add"
          >
            + Add voice
          </button>
          <ul className="cedar-settings-list">
            {settings.profiles.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  onClick={() => patchSettings({ activeProfileId: profile.id })}
                  className={`cedar-settings-list-item${activeProfile?.id === profile.id ? " active" : ""}`}
                >
                  <span className="cedar-settings-list-name">
                    {profile.name || "Voice profile"}
                  </span>
                  <span className="cedar-settings-list-sub">
                    {profile.provider}
                    {profile.voice ? ` · ${profile.voice}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className="cedar-settings-content">
        <div className="cedar-settings-scroll">
          {!activeProfile ? (
            <div className="cedar-section-head">
              <div className="cedar-section-title">No voice profile</div>
              <div className="cedar-section-desc">
                Add a voice profile to configure TTS.
              </div>
            </div>
          ) : (
            <>
              <div className="cedar-section-head">
                <div className="cedar-section-title">{activeProfile.name || "Voice profile"}</div>
                <div className="cedar-section-desc">
                  Configure the upstream that produces speech for this profile.
                </div>
              </div>

              <Field label="Name">
                <input
                  className="input"
                  placeholder="e.g. ElevenLabs Lily"
                  value={activeProfile.name}
                  onChange={(event) => updateProfile({ name: event.target.value })}
                />
              </Field>

              <Field label="Provider">
                <select
                  className="select"
                  value={activeProfile.provider}
                  onChange={(event) =>
                    updateProfile({
                      provider: event.target.value as TtsProviderKind,
                    })
                  }
                >
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="minimax">MiniMax</option>
                  <option value="azure">Azure Speech</option>
                  <option value="edge">Edge / browser speech</option>
                </select>
              </Field>

              {activeProfile.provider !== "edge" && (
                <Field label="API Key">
                  <input
                    className="input"
                    type="password"
                    placeholder={`${providerLabel} key`}
                    value={activeProfile.apiKey}
                    onChange={(event) =>
                      updateProfile({ apiKey: event.target.value })
                    }
                  />
                </Field>
              )}

              {activeProfile.provider === "azure" && (
                <Field label="Azure Region">
                  <input
                    className="input"
                    placeholder="eastus"
                    value={activeProfile.region}
                    onChange={(event) =>
                      updateProfile({ region: event.target.value })
                    }
                  />
                </Field>
              )}

              <Field
                label={activeProfile.provider === "edge" ? "Proxy URL" : "Base URL"}
                hint={
                  activeProfile.provider === "edge"
                    ? "Leave empty to use the browser speech engine."
                    : activeProfile.provider === "minimax"
                      ? "Global keys use https://api.minimax.io. Mainland keys use https://api.minimaxi.com. You can enter the host or the full /v1/t2a_v2 endpoint."
                      : undefined
                }
              >
                <input
                  className="input"
                  placeholder={
                    activeProfile.provider === "elevenlabs"
                      ? "https://api.elevenlabs.io/v1"
                      : activeProfile.provider === "minimax"
                        ? "https://api.minimax.io or https://api.minimaxi.com"
                        : activeProfile.provider === "azure"
                          ? "optional full Azure endpoint"
                          : "optional local edge-tts HTTP endpoint"
                  }
                  value={activeProfile.baseUrl}
                  onChange={(event) =>
                    updateProfile({ baseUrl: event.target.value })
                  }
                />
              </Field>

              {activeProfile.provider === "minimax" && (
                <Field label="Group ID">
                  <input
                    className="input"
                    placeholder="optional"
                    value={activeProfile.groupId}
                    onChange={(event) =>
                      updateProfile({ groupId: event.target.value })
                    }
                  />
                </Field>
              )}

              <Field label="Voice">
                <input
                  className="input"
                  placeholder={
                    activeProfile.provider === "azure"
                      ? "en-US-JennyNeural"
                      : activeProfile.provider === "edge"
                        ? "browser voice name or edge-tts voice"
                        : "voice ID"
                  }
                  value={activeProfile.voice}
                  onChange={(event) => updateProfile({ voice: event.target.value })}
                />
              </Field>

              <Field label="Model">
                <input
                  className="input"
                  placeholder={
                    activeProfile.provider === "elevenlabs"
                      ? "eleven_multilingual_v2"
                      : activeProfile.provider === "minimax"
                        ? "speech-2.8-hd"
                        : "optional"
                  }
                  value={activeProfile.model}
                  onChange={(event) => updateProfile({ model: event.target.value })}
                />
              </Field>

              {activeProfile.provider === "azure" && (
                <Field label="Output format">
                  <input
                    className="input"
                    placeholder="audio-24khz-48kbitrate-mono-mp3"
                    value={activeProfile.outputFormat}
                    onChange={(event) =>
                      updateProfile({ outputFormat: event.target.value })
                    }
                  />
                </Field>
              )}

              {testError && (
                <div className="cedar-notice error">
                  <div className="cedar-notice-title">Voice test failed</div>
                  <div className="cedar-notice-sub">{testError}</div>
                </div>
              )}

              <div className="cedar-settings-footer-spacer" />
            </>
          )}
        </div>

        {activeProfile && (
          <div className="cedar-settings-footer">
            <button
              type="button"
              onClick={testVoice}
              disabled={testing}
              className="cedar-btn-secondary"
            >
              {testing ? "Testing..." : "Test voice"}
            </button>
            <button
              type="button"
              onClick={() => deleteProfile(activeProfile.id)}
              className="cedar-btn-danger"
              style={{ marginLeft: "auto" }}
            >
              Delete
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function SyncPanel({
  settings,
  busy,
  status,
  onChange,
  onPush,
  onPull,
}: {
  settings: SyncSettings;
  busy: boolean;
  status: string | null;
  onChange: (settings: SyncSettings) => void;
  onPush: () => void;
  onPull: () => void;
}) {
  const canSync = settings.endpoint.trim() && settings.syncCode.trim().length >= 8;
  const intervalSeconds = Math.round(settings.autoSyncIntervalMs / 1000);

  return (
    <section className="cedar-settings-content cedar-settings-content--single">
      <div className="cedar-settings-scroll">
        <div className="cedar-section-head">
          <div className="cedar-section-title">Cloud sync</div>
          <div className="cedar-section-desc">
            Encrypted sync of conversations, agents, providers and preferences
            across your devices through a self-hosted gateway.
          </div>
        </div>

        <Field label="Sync URL">
          <input
            className="input"
            placeholder="https://mcp-gateway.yixinliu1024.workers.dev"
            value={settings.endpoint}
            onChange={(event) =>
              onChange({ ...settings, endpoint: event.target.value })
            }
          />
        </Field>

        <Field label="Sync Code">
          <input
            className="input"
            type="password"
            placeholder="at least 8 characters"
            value={settings.syncCode}
            onChange={(event) =>
              onChange({ ...settings, syncCode: event.target.value })
            }
          />
        </Field>

        <Field label="Device Name">
          <input
            className="input"
            placeholder="MacBook, iPhone..."
            value={settings.deviceName}
            onChange={(event) =>
              onChange({ ...settings, deviceName: event.target.value })
            }
          />
        </Field>

        <div className="cedar-section-head" style={{ marginTop: "1.25rem" }}>
          <div className="cedar-section-title">Auto sync</div>
          <div className="cedar-section-desc">
            Sync automatically when the tab is visible, on focus and on network
            reconnect.
          </div>
        </div>

        <label className="cedar-inline-checkbox">
          <input
            type="checkbox"
            checked={settings.autoSyncEnabled}
            disabled={!canSync}
            onChange={(event) =>
              onChange({ ...settings, autoSyncEnabled: event.target.checked })
            }
          />
          Enable auto sync
        </label>

        {settings.autoSyncEnabled && (
          <Field label="Sync interval (seconds)">
            <div className="cedar-range-row">
              <input
                type="range"
                min={10}
                max={600}
                step={10}
                value={intervalSeconds}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    autoSyncIntervalMs: parseInt(event.target.value) * 1000,
                  })
                }
                aria-label="Auto sync interval"
              />
              <input
                type="number"
                min={10}
                max={600}
                value={intervalSeconds}
                onChange={(event) =>
                  onChange({
                    ...settings,
                    autoSyncIntervalMs:
                      Math.max(10, Math.min(600, parseInt(event.target.value) || 30)) *
                      1000,
                  })
                }
                className="input"
                aria-label="Auto sync interval in seconds"
              />
              <span className="unit">sec</span>
            </div>
          </Field>
        )}

        <div className="cedar-field-hint" style={{ marginTop: "0.5rem" }}>
          <div>Last upload: {formatSyncTime(settings.lastPushedAt)}</div>
          <div>Last download: {formatSyncTime(settings.lastPulledAt)}</div>
        </div>

        {status && (
          <div className="cedar-notice">
            <div className="cedar-notice-sub">{status}</div>
          </div>
        )}

        <div className="cedar-settings-footer-spacer" />
      </div>

      <div className="cedar-settings-footer">
        <button
          type="button"
          onClick={onPull}
          disabled={busy || !canSync}
          className="cedar-btn-primary"
        >
          {busy ? "Syncing..." : "Sync"}
        </button>
        <button
          type="button"
          onClick={onPush}
          disabled={busy || !canSync}
          className="cedar-btn-secondary"
        >
          Upload only
        </button>
      </div>
    </section>
  );
}

function formatSyncTime(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function PreferencesPanel({
  preferences,
  userStyleSettings,
  providers,
  onChange,
  onUserStyleSettingsChange,
}: {
  preferences: Preferences;
  userStyleSettings: UserStyleSettings;
  providers: ProviderConfig[];
  onChange: (p: Preferences) => void;
  onUserStyleSettingsChange: (settings: UserStyleSettings) => void;
}) {
  const depth = preferences.historyDepth;
  const isUnlimited = depth === "all";
  const numericDepth = typeof depth === "number" ? depth : 20;
  const chatFontSize = preferences.chatFontSize;
  const chatDisplayMode = preferences.chatDisplayMode;

  // ── Thinking summary 派生 ─────────────────────────────────
  const summaryProvider = preferences.thinkingSummaryProviderId
    ? providers.find((p) => p.id === preferences.thinkingSummaryProviderId) ?? null
    : null;
  const summaryProviderModels = summaryProvider?.models ?? [];

  return (
    <section className="cedar-settings-content cedar-settings-content--single">
      <div className="cedar-settings-scroll">
        <div className="cedar-section-head">
          <div className="cedar-section-title">Chat appearance</div>
          <div className="cedar-section-desc">
            Switch the main chat surface between Cedar, WeChat, and a Claude.ai-style layout.
          </div>
        </div>

        <div className="cedar-preference-segmented" aria-label="Chat appearance">
          <button
            type="button"
            className={chatDisplayMode === "cedar" ? "active" : undefined}
            aria-pressed={chatDisplayMode === "cedar"}
            onClick={() =>
              onChange({ ...preferences, chatDisplayMode: "cedar" })
            }
          >
            Cedar
          </button>
          <button
            type="button"
            className={chatDisplayMode === "wechat" ? "active" : undefined}
            aria-pressed={chatDisplayMode === "wechat"}
            onClick={() =>
              onChange({ ...preferences, chatDisplayMode: "wechat" })
            }
          >
            微信风格
          </button>
          <button
            type="button"
            className={chatDisplayMode === "claudeai" ? "active" : undefined}
            aria-pressed={chatDisplayMode === "claudeai"}
            onClick={() =>
              onChange({ ...preferences, chatDisplayMode: "claudeai" })
            }
          >
            Claude.ai
          </button>
        </div>

        <div className="cedar-section-head" style={{ marginTop: "1.5rem" }}>
          <div className="cedar-section-title">Chat text size</div>
          <div className="cedar-section-desc">
            Adjust the reading size for message text and the composer.
          </div>
        </div>

        <div className="cedar-range-row">
          <input
            type="range"
            min={14}
            max={24}
            step={1}
            value={chatFontSize}
            onChange={(e) =>
              onChange({
                ...preferences,
                chatFontSize: parseInt(e.target.value),
              })
            }
            aria-label="Chat text size"
          />
          <input
            type="number"
            min={14}
            max={24}
            value={chatFontSize}
            onChange={(e) =>
              onChange({
                ...preferences,
                chatFontSize: Math.max(
                  14,
                  Math.min(24, parseInt(e.target.value) || 18),
                ),
              })
            }
            className="input"
            aria-label="Chat text size in pixels"
          />
          <span className="unit">px</span>
        </div>

        <div className="cedar-section-head" style={{ marginTop: "1.5rem" }}>
          <div className="cedar-section-title">Conversation history</div>
          <div className="cedar-section-desc">
            How many past messages to include when sending a new message. Fewer
            messages = cheaper requests + faster responses, but the model has
            less memory of earlier turns.
          </div>
        </div>

        <label className="cedar-inline-checkbox">
          <input
            type="checkbox"
            checked={isUnlimited}
            onChange={(e) =>
              onChange({
                ...preferences,
                historyDepth: e.target.checked ? "all" : numericDepth,
              })
            }
          />
          Unlimited (send all history)
        </label>

        {!isUnlimited && (
          <div className="cedar-range-row" style={{ marginTop: "0.75rem" }}>
            <input
              type="range"
              min={0}
              max={300}
              step={1}
              value={numericDepth}
              onChange={(e) =>
                onChange({
                  ...preferences,
                  historyDepth: parseInt(e.target.value),
                })
              }
            />
            <input
              type="number"
              min={0}
              max={300}
              value={numericDepth}
              onChange={(e) =>
                onChange({
                  ...preferences,
                  historyDepth: Math.max(
                    0,
                    Math.min(300, parseInt(e.target.value) || 0),
                  ),
                })
              }
              className="input"
            />
            <span className="unit">messages</span>
          </div>
        )}

        <div className="cedar-field-hint" style={{ marginTop: "0.5rem" }}>
          <strong>0</strong> = one-shot (no history).{" "}
          <strong>20</strong> ≈ last 10 user/assistant pairs.
        </div>

        <div className="cedar-section-head" style={{ marginTop: "1.5rem" }}>
          <div className="cedar-section-title">Thinking auto-summary</div>
          <div className="cedar-section-desc">
            When a reasoning model finishes a thinking segment, silently run a
            small model on JUST that segment (no system / history) to produce a
            one-line summary shown at the top of the collapsed thinking block.
            Doesn't affect the main response.
          </div>
        </div>

        <label className="cedar-inline-checkbox">
          <input
            type="checkbox"
            checked={preferences.thinkingSummaryEnabled}
            onChange={(event) =>
              onChange({
                ...preferences,
                thinkingSummaryEnabled: event.target.checked,
              })
            }
          />
          Enable thinking auto-summary
        </label>

        {preferences.thinkingSummaryEnabled && (
          <div className="cedar-field-grid" style={{ marginTop: "0.75rem" }}>
            <Field label="Summary provider" hint="Pick any provider you have configured.">
              <select
                className="select"
                value={preferences.thinkingSummaryProviderId ?? ""}
                onChange={(event) => {
                  const nextId = event.target.value || null;
                  const nextProvider = nextId
                    ? providers.find((p) => p.id === nextId) ?? null
                    : null;
                  onChange({
                    ...preferences,
                    thinkingSummaryProviderId: nextId,
                    // Provider 换了就重置 model,避免残留无效值
                    thinkingSummaryModel:
                      nextProvider?.models?.[0] ?? null,
                  });
                }}
              >
                <option value="">— choose provider —</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Summary model"
              hint="Cheap fast models work best (e.g. claude-haiku, gpt-4o-mini, deepseek-chat)."
            >
              {summaryProviderModels.length > 0 ? (
                <select
                  className="select"
                  value={preferences.thinkingSummaryModel ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...preferences,
                      thinkingSummaryModel: event.target.value || null,
                    })
                  }
                  disabled={!summaryProvider}
                >
                  {summaryProviderModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input font-mono"
                  placeholder="model-id (provider has no preset list)"
                  value={preferences.thinkingSummaryModel ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...preferences,
                      thinkingSummaryModel: event.target.value || null,
                    })
                  }
                  disabled={!summaryProvider}
                />
              )}
            </Field>
          </div>
        )}

        <div className="cedar-section-head" style={{ marginTop: "1.5rem" }}>
          <div className="cedar-section-title">User style</div>
          <div className="cedar-section-desc">
            Maintain multiple style presets and switch between them. The active
            preset is appended to every message regardless of which Agent is
            running. Synced across devices via cloud sync.
          </div>
        </div>

        <UserStyleEditor
          settings={userStyleSettings}
          onChange={onUserStyleSettingsChange}
        />

        <div className="cedar-settings-footer-spacer" />
      </div>
    </section>
  );
}

function UserStyleEditor({
  settings,
  onChange,
}: {
  settings: UserStyleSettings;
  onChange: (settings: UserStyleSettings) => void;
}) {
  // 选中正在编辑的 profile(默认跟随 active);"none" = 没启用任何 style
  const initialSelected =
    settings.activeProfileId ?? settings.profiles[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(initialSelected);

  const selected =
    settings.profiles.find((profile) => profile.id === selectedId) ?? null;

  function patchSettings(next: Partial<UserStyleSettings>) {
    onChange({ ...settings, ...next });
  }

  function updateProfile(id: string, patch: Partial<UserStyleProfile>) {
    onChange({
      ...settings,
      profiles: settings.profiles.map((profile) =>
        profile.id === id
          ? { ...profile, ...patch, updatedAt: Date.now() }
          : profile,
      ),
    });
  }

  function addProfile() {
    const profile = createUserStyleProfile({
      name: `Style ${settings.profiles.length + 1}`,
    });
    onChange({
      activeProfileId: settings.activeProfileId ?? profile.id, // 第一次添加默认激活
      profiles: [...settings.profiles, profile],
    });
    setSelectedId(profile.id);
  }

  function deleteProfile(id: string) {
    if (!confirm("Delete this style preset?")) return;
    const nextProfiles = settings.profiles.filter((profile) => profile.id !== id);
    const nextActiveId =
      settings.activeProfileId === id ? null : settings.activeProfileId;
    onChange({
      activeProfileId: nextActiveId,
      profiles: nextProfiles,
    });
    if (selectedId === id) {
      setSelectedId(nextProfiles[0]?.id ?? null);
    }
  }

  function activateProfile(id: string | null) {
    patchSettings({ activeProfileId: id });
  }

  return (
    <div className="cedar-style-editor">
      <aside className="cedar-style-editor__list">
        <button
          type="button"
          onClick={() => activateProfile(null)}
          className={`cedar-settings-list-item${settings.activeProfileId === null ? " active" : ""}`}
          title="Disable user style"
        >
          <span className="cedar-settings-list-name">Off</span>
          <span className="cedar-settings-list-sub">No style appended</span>
        </button>

        {settings.profiles.map((profile) => {
          const isActive = settings.activeProfileId === profile.id;
          const isSelected = selectedId === profile.id;
          return (
            <div
              key={profile.id}
              className={`cedar-style-row${isSelected ? " is-selected" : ""}`}
            >
              <button
                type="button"
                onClick={() => setSelectedId(profile.id)}
                className={`cedar-settings-list-item${isActive ? " active" : ""}`}
                style={{ flex: 1 }}
              >
                <span className="cedar-settings-list-name">
                  {profile.name || "Untitled style"}
                  {isActive && <span className="cedar-style-badge">active</span>}
                </span>
                <span className="cedar-settings-list-sub">
                  {profile.prompt.trim()
                    ? profile.prompt.replace(/\s+/g, " ").slice(0, 64) +
                      (profile.prompt.length > 64 ? "…" : "")
                    : "(empty)"}
                </span>
              </button>
              {!isActive ? (
                <button
                  type="button"
                  onClick={() => activateProfile(profile.id)}
                  className="cedar-btn-ghost cedar-style-row__use"
                  title="Make this the active style"
                >
                  Use
                </button>
              ) : null}
            </div>
          );
        })}

        <button
          type="button"
          onClick={addProfile}
          className="cedar-settings-list-add"
        >
          + Add style
        </button>
      </aside>

      <div className="cedar-style-editor__form">
        {!selected ? (
          <div className="cedar-section-desc">
            Select a style preset to edit, or add a new one.
          </div>
        ) : (
          <>
            <Field label="Name">
              <input
                className="input"
                placeholder="e.g. Concise Chinese"
                value={selected.name}
                onChange={(event) =>
                  updateProfile(selected.id, { name: event.target.value })
                }
              />
            </Field>

            <Field
              label="Prompt"
              hint="Appended to every message. Leave blank to keep the preset around but inactive when 'Off' is selected."
            >
              <textarea
                className="input font-mono"
                rows={8}
                placeholder="e.g. Reply in concise Chinese. Use TypeScript for code examples. Avoid emoji."
                value={selected.prompt}
                onChange={(event) =>
                  updateProfile(selected.id, { prompt: event.target.value })
                }
              />
            </Field>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {settings.activeProfileId !== selected.id ? (
                <button
                  type="button"
                  onClick={() => activateProfile(selected.id)}
                  className="cedar-btn-primary"
                >
                  Set as active
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => activateProfile(null)}
                  className="cedar-btn-secondary"
                >
                  Deactivate
                </button>
              )}
              <button
                type="button"
                onClick={() => deleteProfile(selected.id)}
                className="cedar-btn-danger"
                style={{ marginLeft: "auto" }}
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="cedar-field">
      <span className="cedar-field-label">{label}</span>
      <div className="cedar-field-control">{children}</div>{/* keeps the input/textarea/select grouped */}
      {hint && <div className="cedar-field-hint">{hint}</div>}
    </label>
  );
}
