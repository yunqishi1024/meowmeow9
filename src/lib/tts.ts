import type { TtsProfile } from "./storage";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
const MINIMAX_BASE_URL = "https://api.minimax.io";
const AZURE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export async function playTts(
  settings: TtsProfile,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  if (settings.provider === "edge" && !settings.baseUrl.trim()) {
    await speakWithBrowserTts(text, settings.voice);
    return;
  }

  const blob = await synthesizeSpeech(settings, text, signal);
  await playAudioBlob(blob);
}

export async function synthesizeSpeech(
  settings: TtsProfile,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const cleanText = text.trim();
  if (!cleanText) throw new Error("Nothing to read.");

  switch (settings.provider) {
    case "elevenlabs":
      return synthesizeElevenLabs(settings, cleanText, signal);
    case "minimax":
      return synthesizeMiniMax(settings, cleanText, signal);
    case "azure":
      return synthesizeAzure(settings, cleanText, signal);
    case "edge":
      return synthesizeEdgeProxy(settings, cleanText, signal);
    default: {
      const exhaustive: never = settings.provider;
      throw new Error(`Unknown TTS provider: ${exhaustive}`);
    }
  }
}

export function stopBrowserTts(): void {
  window.speechSynthesis?.cancel();
}

async function synthesizeElevenLabs(
  settings: TtsProfile,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  requireField(settings.apiKey, "ElevenLabs API key");
  requireField(settings.voice, "ElevenLabs voice ID");

  const baseUrl = trimTrailingSlash(settings.baseUrl || ELEVENLABS_BASE_URL);
  const response = await fetch(
    `${baseUrl}/text-to-speech/${encodeURIComponent(settings.voice)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": settings.apiKey.trim(),
      },
      body: JSON.stringify({
        text,
        model_id: settings.model || "eleven_multilingual_v2",
      }),
      signal,
    },
  );

  return responseToAudioBlob(response, "ElevenLabs");
}

async function synthesizeMiniMax(
  settings: TtsProfile,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  requireField(settings.apiKey, "MiniMax API key");
  requireField(settings.voice, "MiniMax voice ID");

  const endpoint = minimaxEndpoint(settings.baseUrl || MINIMAX_BASE_URL);
  const groupQuery = settings.groupId
    ? `?GroupId=${encodeURIComponent(settings.groupId)}`
    : "";
  const response = await fetch(`${endpoint}${groupQuery}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.model || "speech-2.8-hd",
      text,
      stream: false,
      language_boost: "auto",
      output_format: "hex",
      voice_setting: {
        voice_id: settings.voice,
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(await errorMessage(response, "MiniMax"));
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("audio/")) return response.blob();

  const json = (await response.json()) as unknown;
  return audioBlobFromJson(json, "audio/mpeg", "MiniMax");
}

async function synthesizeAzure(
  settings: TtsProfile,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  requireField(settings.apiKey, "Azure Speech key");
  requireField(settings.voice, "Azure voice name");

  const endpoint = settings.baseUrl.trim()
    ? trimTrailingSlash(settings.baseUrl)
    : settings.region.trim()
      ? `https://${settings.region}.tts.speech.microsoft.com/cognitiveservices/v1`
      : "";
  requireField(endpoint, "Azure endpoint or region");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/ssml+xml",
      "Ocp-Apim-Subscription-Key": settings.apiKey.trim(),
      "X-Microsoft-OutputFormat":
        settings.outputFormat || AZURE_OUTPUT_FORMAT,
    },
    body: `<speak version="1.0" xml:lang="en-US"><voice name="${escapeXml(
      settings.voice,
    )}">${escapeXml(text)}</voice></speak>`,
    signal,
  });

  return responseToAudioBlob(response, "Azure Speech");
}

async function synthesizeEdgeProxy(
  settings: TtsProfile,
  text: string,
  signal?: AbortSignal,
): Promise<Blob> {
  requireField(settings.baseUrl, "Edge TTS proxy URL");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`;
  }

  const response = await fetch(settings.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      voice: settings.voice,
      model: settings.model,
      outputFormat: settings.outputFormat,
    }),
    signal,
  });

  if (!response.ok) throw new Error(await errorMessage(response, "Edge TTS"));
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("audio/")) return response.blob();
  return audioBlobFromJson((await response.json()) as unknown, "audio/mpeg", "Edge TTS");
}

async function responseToAudioBlob(
  response: Response,
  providerName: string,
): Promise<Blob> {
  if (!response.ok) throw new Error(await errorMessage(response, providerName));
  return response.blob();
}

async function errorMessage(
  response: Response,
  providerName: string,
): Promise<string> {
  const text = await response.text().catch(() => "");
  return `${providerName} TTS error ${response.status}: ${text.slice(0, 500)}`;
}

function audioBlobFromJson(
  value: unknown,
  mimeType: string,
  providerName: string,
): Blob {
  const root = asRecord(value);
  const data = asRecord(root.data);
  assertSuccessfulJsonResponse(root, providerName);

  const encoded =
    asString(data.audio) ??
    asString(data.audio_file) ??
    asString(data.audioFile) ??
    asString(root.audio) ??
    asString(root.audio_file) ??
    asString(root.audioFile) ??
    asString(root.audioContent) ??
    asString(root.audio_content);

  if (!encoded) {
    const audioUrl =
      asString(data.audio_url) ??
      asString(data.audioUrl) ??
      asString(root.audio_url) ??
      asString(root.audioUrl);
    const traceId = asString(root.trace_id);
    throw new Error(
      `${providerName} response did not include audio data.` +
        (audioUrl ? ` It returned an audio URL instead: ${audioUrl}` : "") +
        (traceId ? ` trace_id=${traceId}.` : "") +
        ` Response keys: ${Object.keys(root).join(", ") || "(none)"}.`,
    );
  }

  return encodedAudioToBlob(encoded, mimeType);
}

function assertSuccessfulJsonResponse(
  root: Record<string, unknown>,
  providerName: string,
): void {
  const baseResp = asRecord(root.base_resp);
  const statusCode =
    asNumber(baseResp.status_code) ?? asNumber(baseResp.code);
  const statusMsg =
    asString(baseResp.status_msg) ??
    asString(baseResp.message) ??
    asString(root.message) ??
    asString(root.error);

  if (statusCode !== undefined && statusCode !== 0) {
    const traceId = asString(root.trace_id);
    const hint =
      providerName === "MiniMax" && statusCode === 2049
        ? " Check that your API key and Base URL are from the same region: Global uses https://api.minimax.io, Mainland uses https://api.minimaxi.com."
        : "";
    throw new Error(
      `${providerName} TTS error ${statusCode}: ${statusMsg ?? "unknown error"}` +
        (traceId ? ` trace_id=${traceId}.` : "") +
        hint,
    );
  }
}

function encodedAudioToBlob(value: string, mimeType: string): Blob {
  if (value.startsWith("data:")) {
    const [header, body = ""] = value.split(",", 2);
    const match = header.match(/^data:([^;]+)/);
    return encodedAudioToBlob(body, match?.[1] ?? mimeType);
  }

  const compact = value.replace(/\s+/g, "");
  const bytes = /^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0
    ? hexToBytes(compact)
    : base64ToBytes(compact);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buffer], { type: mimeType });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Audio playback failed."));
    };
    audio.play().catch((error: unknown) => {
      URL.revokeObjectURL(url);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function speakWithBrowserTts(text: string, voiceName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const synthesis = window.speechSynthesis;
    if (!synthesis) {
      reject(new Error("Browser speech synthesis is not available."));
      return;
    }

    synthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const selectedVoice = synthesis
      .getVoices()
      .find((voice) => voice.name === voiceName || voice.voiceURI === voiceName);
    if (selectedVoice) utterance.voice = selectedVoice;

    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error("Browser speech synthesis failed."));
    synthesis.speak(utterance);
  });
}

function requireField(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function minimaxEndpoint(value: string): string {
  const clean = trimTrailingSlash(value);
  return clean.endsWith("/v1/t2a_v2") ? clean : `${clean}/v1/t2a_v2`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
