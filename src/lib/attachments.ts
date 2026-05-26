import type {
  AttachmentKind,
  ChatAttachment,
  ChatContentPart,
  ContentBlock,
} from "../providers";

const MAX_TEXT_CHARS = 120_000;
const MAX_PDF_SCAN_BYTES = 5_000_000;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "css",
]);

const CODE_EXTENSIONS = new Set([
  "py",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "java",
  "c",
  "cpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "sql",
  "sh",
  "zsh",
  "bash",
  "toml",
]);

function attachmentId() {
  return "att_" + Math.random().toString(36).slice(2, 10);
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function inferAttachmentKind(file: File): AttachmentKind {
  const ext = extensionOf(file.name);
  if (file.type.startsWith("image/")) return "image";
  if (ext === "ipynb") return "notebook";
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) return "text";
  return "other";
}

function limitText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= MAX_TEXT_CHARS) return normalized;
  return (
    normalized.slice(0, MAX_TEXT_CHARS) +
    `\n\n[Attachment truncated after ${MAX_TEXT_CHARS.toLocaleString()} characters.]`
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read file as data URL."));
    reader.onerror = () => reject(reader.error ?? new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}

export async function attachmentFromFile(file: File): Promise<ChatAttachment> {
  const kind = inferAttachmentKind(file);
  const base = {
    id: attachmentId(),
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    size: file.size,
    kind,
  };

  if (kind === "image") {
    return {
      ...base,
      dataUrl: await fileToDataUrl(file),
    };
  }

  if (kind === "notebook") {
    try {
      return {
        ...base,
        text: limitText(notebookToText(await file.text())),
      };
    } catch {
      return {
        ...base,
        error: "Could not read this notebook.",
      };
    }
  }

  if (kind === "pdf") {
    const text = extractPdfText(await file.arrayBuffer());
    return {
      ...base,
      ...(text
        ? { text: limitText(text) }
        : {
            error:
              "PDF text extraction is limited in the browser. Try exporting this PDF as text if the model needs the full contents.",
          }),
    };
  }

  if (kind === "text" || kind === "code") {
    try {
      return {
        ...base,
        text: limitText(await file.text()),
      };
    } catch {
      return {
        ...base,
        error: "Could not read this file as text.",
      };
    }
  }

// 特殊处理 .docx：保留原始 File 引用供翻译功能使用
if (file.name.endsWith(".docx")) {
  return {
    ...base,
    file,
  } as ChatAttachment;
}

return {
  ...base,
  error: "This file type can be attached for reference, but Cedar Chat cannot read its contents yet.",
};

  return {
    ...base,
    error: "This file type can be attached for reference, but Cedar Chat cannot read its contents yet.",
  };
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function contentBlocksToPlainText(
  content: ContentBlock[],
  includeAttachments = false,
): string {
  return content
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "voice") return block.text;
      if (block.type === "tool") {
        return includeAttachments
          ? [
              `[Tool: ${block.name} · ${block.status}]`,
              block.input ? `Input:\n${block.input}` : "",
              block.output ? `Output:\n${block.output}` : "",
              block.error ? `Error:\n${block.error}` : "",
            ]
              .filter(Boolean)
              .join("\n")
          : "";
      }
      if (!includeAttachments) return "";
      const { attachment } = block;
      return attachment.text
        ? `[Attached file: ${attachment.name}]\n${attachment.text}`
        : `[Attached file: ${attachment.name}]`;
    })
    .filter(Boolean)
    .join("\n\n");
}

export function contentBlocksToPromptParts(
  content: ContentBlock[],
): ChatContentPart[] {
  const parts: ChatContentPart[] = [];

  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim()) parts.push({ type: "text", text: block.text });
      continue;
    }

    if (block.type === "voice") {
      parts.push({
        type: "text",
        text: block.text,
      });
      continue;
    }

    if (block.type !== "attachment") continue;

    const { attachment } = block;
    const header = `[Attached file: ${attachment.name} (${attachment.kind}, ${attachment.mediaType}, ${formatBytes(attachment.size)})]`;
    if (attachment.text) {
      parts.push({
        type: "text",
        text: `${header}\n\n${attachment.text}`,
      });
    } else if (attachment.error) {
      parts.push({
        type: "text",
        text: `${header}\n${attachment.error}`,
      });
    } else {
      parts.push({ type: "text", text: header });
    }

    if (attachment.kind === "image" && attachment.dataUrl) {
      parts.push({
        type: "image_url",
        image_url: { url: attachment.dataUrl },
      });
    }
  }

  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

export function hasUserContent(text: string, attachments: ChatAttachment[]) {
  return text.trim().length > 0 || attachments.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function sourceToString(source: unknown): string {
  if (Array.isArray(source)) {
    return source.map((part) => (typeof part === "string" ? part : "")).join("");
  }
  return typeof source === "string" ? source : "";
}

function notebookToText(raw: string): string {
  const parsed = asRecord(JSON.parse(raw) as unknown);
  const cells = Array.isArray(parsed.cells) ? parsed.cells : [];

  return cells
    .map((cell, index) => {
      const record = asRecord(cell);
      const cellType =
        typeof record.cell_type === "string" ? record.cell_type : "cell";
      const source = sourceToString(record.source).trim();
      if (!source) return "";
      return `# Cell ${index + 1} (${cellType})\n${source}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function bytesToLatin1(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.slice(i, i + 8192);
    chunks.push(String.fromCharCode(...chunk));
  }
  return chunks.join("");
}

function extractPdfText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer.slice(0, MAX_PDF_SCAN_BYTES));
  const raw = bytesToLatin1(bytes);
  const strings = [
    ...extractPdfLiterals(raw),
    ...extractPdfArrayStrings(raw),
    ...extractPdfMetadata(raw),
  ];
  const cleaned = strings
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 1 && /[A-Za-z0-9\u3400-\u9fff]/.test(item));

  return Array.from(new Set(cleaned)).join("\n");
}

function extractPdfLiterals(raw: string): string[] {
  const results: string[] = [];
  const literalPattern = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g;
  for (const match of raw.matchAll(literalPattern)) {
    const token = match[0].replace(/\s*(?:Tj|'|")$/, "");
    results.push(decodePdfLiteral(token.slice(1, -1)));
  }
  return results;
}

function extractPdfArrayStrings(raw: string): string[] {
  const results: string[] = [];
  const arrayPattern = /\[((?:.|\n){0,4000}?)\]\s*TJ/g;
  for (const match of raw.matchAll(arrayPattern)) {
    const body = match[1];
    const pieces: string[] = [];
    for (const literal of body.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
      pieces.push(decodePdfLiteral(literal[0].slice(1, -1)));
    }
    for (const hex of body.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      pieces.push(decodePdfHex(hex[1]));
    }
    if (pieces.length > 0) results.push(pieces.join(""));
  }
  return results;
}

function extractPdfMetadata(raw: string): string[] {
  const results: string[] = [];
  for (const match of raw.matchAll(/\/(?:Title|Subject|Keywords)\s*\((.*?)\)/g)) {
    results.push(decodePdfLiteral(match[1]));
  }
  return results;
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/g, (_, code: string) => {
      switch (code) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "b":
          return "\b";
        case "f":
          return "\f";
        default:
          return code;
      }
    })
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) =>
      String.fromCharCode(parseInt(octal, 8)),
    )
    .replace(/\\\r?\n/g, "");
}

function decodePdfHex(value: string): string {
  const clean = value.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16));
  }

  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return text;
  }

  return String.fromCharCode(...bytes);
}
