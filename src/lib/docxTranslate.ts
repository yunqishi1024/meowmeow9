// src/lib/docxTranslate.ts
//
// Word 文档保格式翻译 - 纯前端方案
// 原理：.docx 本质是 zip 包，里面是 XML。只替换文本节点，格式全部保留。
// 依赖：npm install jszip

import JSZip from "jszip";

// ============================================================
// 第一部分：解析和写回 docx
// ============================================================

export interface DocxParseResult {
  zip: JSZip;
  paragraphs: string[];
  paragraphRanges: Array<{ start: number; end: number }>;
  allTexts: string[];
}

export async function parseDocx(file: File): Promise<DocxParseResult> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("无法读取 word/document.xml，请确认是有效的 .docx 文件");

  const docXml = await docFile.async("string");

  const allTexts: string[] = [];
  const wtRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = wtRegex.exec(docXml)) !== null) {
    allTexts.push(match[1]);
  }

  const paragraphs: string[] = [];
  const paragraphRanges: Array<{ start: number; end: number }> = [];

  const paragraphRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  let pMatch: RegExpExecArray | null;
  let globalTextIndex = 0;

  const wtInParagraphRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  while ((pMatch = paragraphRegex.exec(docXml)) !== null) {
    const pContent = pMatch[0];
    const textsInP: string[] = [];
    let innerMatch: RegExpExecArray | null;
    const start = globalTextIndex;

    wtInParagraphRegex.lastIndex = 0;
    while ((innerMatch = wtInParagraphRegex.exec(pContent)) !== null) {
      textsInP.push(innerMatch[1]);
      globalTextIndex++;
    }

    if (textsInP.length > 0) {
      const combined = textsInP.join("");
      if (combined.trim()) {
        paragraphs.push(combined);
        paragraphRanges.push({ start, end: globalTextIndex });
      }
    }
  }

  return { zip, paragraphs, paragraphRanges, allTexts };
}

export async function writeTranslatedDocx(
  parseResult: DocxParseResult,
  translatedParagraphs: string[]
): Promise<Blob> {
  const { zip, paragraphRanges, allTexts } = parseResult;

  const newTexts = [...allTexts];

  for (let i = 0; i < translatedParagraphs.length; i++) {
    const range = paragraphRanges[i];
    const translated = translatedParagraphs[i];
    const originalSlotCount = range.end - range.start;

    if (originalSlotCount === 1) {
      newTexts[range.start] = translated;
    } else {
      newTexts[range.start] = translated;
      for (let j = range.start + 1; j < range.end; j++) {
        newTexts[j] = "";
      }
    }
  }

  let docXml = await zip.file("word/document.xml")!.async("string");
  let textIndex = 0;

  docXml = docXml.replace(
    /<w:t([^>]*)>([\s\S]*?)<\/w:t>/g,
    (_fullMatch: string, attrs: string) => {
      if (textIndex < newTexts.length) {
        const replacement = newTexts[textIndex];
        textIndex++;
        const attrStr = replacement.length > 0
          ? (attrs.includes('xml:space') ? attrs : ` xml:space="preserve"${attrs}`)
          : attrs;
        return `<w:t${attrStr}>${escapeXml(replacement)}</w:t>`;
      }
      return _fullMatch;
    }
  );

  zip.file("word/document.xml", docXml);

  return await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// 第二部分：调用 API 批量翻译
// ============================================================

export interface TranslateOptions {
  targetLang: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  batchSize?: number;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}

export async function translateParagraphs(
  paragraphs: string[],
  options: TranslateOptions
): Promise<string[]> {
  const { targetLang, baseUrl, apiKey, model, batchSize = 30, onProgress, signal } = options;
  const results: string[] = [];

  for (let i = 0; i < paragraphs.length; i += batchSize) {
    if (signal?.aborted) throw new Error("翻译已取消");

    const batch = paragraphs.slice(i, i + batchSize);

    const prompt = `你是一个专业翻译。请将以下 JSON 数组中的每一项文本翻译成${targetLang}。

要求：
1. 只翻译文字内容，不要改变数组结构
2. 保持数组长度不变，每项一一对应
3. 只输出翻译后的 JSON 数组，不要任何额外解释
4. 保留原文中的数字、专有名词（如品牌名）

输入：
${JSON.stringify(batch, null, 2)}

输出：`;

    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`API 错误 ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";

    const translated = parseTranslationResponse(content, batch);
    results.push(...translated);

    onProgress?.(Math.min(i + batchSize, paragraphs.length), paragraphs.length);
  }

  return results;
}

function parseTranslationResponse(content: string, originalBatch: string[]): string[] {
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length === originalBatch.length) {
        return parsed.map(String);
      }
    } catch { /* fallthrough */ }
  }

  const lines = content.split("\n").map((l) => l.replace(/^\d+[.)]\s*/, "").trim()).filter(Boolean);
  if (lines.length === originalBatch.length) return lines;

  console.warn("翻译结果解析失败，保留原文");
  return originalBatch;
}

// ============================================================
// 第三部分：一键入口
// ============================================================

export interface DocxTranslateResult {
  blob: Blob;
  filename: string;
  paragraphCount: number;
}

export async function translateDocx(
  file: File,
  options: TranslateOptions
): Promise<DocxTranslateResult> {
  const parseResult = await parseDocx(file);

  if (parseResult.paragraphs.length === 0) {
    throw new Error("文档中没有可翻译的文本内容");
  }

  const translatedParagraphs = await translateParagraphs(parseResult.paragraphs, options);
  const blob = await writeTranslatedDocx(parseResult, translatedParagraphs);

  const baseName = file.name.replace(/\.docx$/i, "");
  const filename = `${baseName}_${options.targetLang}.docx`;

  return { blob, filename, paragraphCount: parseResult.paragraphs.length };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
