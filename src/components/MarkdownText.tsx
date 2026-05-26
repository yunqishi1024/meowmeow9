// src/components/MarkdownText.tsx
//
// 完整的 Markdown 渲染组件 —— 替换 App.tsx 底部原有的 MarkdownText
// 支持：标题、加粗、斜体、删除线、链接、行内code、列表、代码块(带Artifact预览)

import { ArtifactView } from "./ArtifactView";
import { memo, useState, type ReactNode } from "react";

const MAX_ARTIFACT_PREVIEW_CHARS = 40_000;

// ============================================================
// 主组件
// ============================================================

export const MarkdownText = memo(function MarkdownText({
  text,
  disableArtifacts = false,
  plainText = false,
}: {
  text: string;
  disableArtifacts?: boolean;
  plainText?: boolean;
}) {
  if (plainText) {
    return (
      <div className="markdown-body">
        <p>{text}</p>
      </div>
    );
  }

  // 按 ``` 分割：奇数索引是代码块，偶数索引是普通文本
  const blocks = text.split(/```/);

  return (
    <div className="markdown-body">
      {blocks.map((block, index) => {
        if (index % 2 === 1) {
          // 代码块
          const lines = block.replace(/^\n/, "").split("\n");
          const maybeLang = lines[0]?.trim() ?? "";
          const hasLang = /^[\w#+.-]+$/.test(maybeLang);
          const language = hasLang ? maybeLang : "";
          const code = (hasLang ? lines.slice(1) : lines).join("\n").trimEnd();
          const canPreviewArtifact =
            !disableArtifacts && code.length <= MAX_ARTIFACT_PREVIEW_CHARS;
          const deferredLanguage = deferredHtmlLanguage(language, code);

          return canPreviewArtifact ? (
            <ArtifactView key={index} language={language} code={code} />
          ) : !disableArtifacts && deferredLanguage ? (
            <DeferredHtmlBlock key={index} language={deferredLanguage} code={code} />
          ) : (
            <PlainCodeBlock key={index} language={language} code={code} />
          );
        }

        // 普通文本
        return <span key={index}>{renderMarkdownLines(block, index)}</span>;
      })}
    </div>
  );
});

function deferredHtmlLanguage(language: string, code: string): string | null {
  const lang = language.toLowerCase();
  if (lang === "html" || lang === "htm") return language || "html";
  if (language) return null;
  return looksLikeHtml(code) ? "html" : null;
}

function looksLikeHtml(code: string): boolean {
  const sample = code.slice(0, 2_000);
  return /<!doctype\s+html/i.test(sample) || /<html[\s>]/i.test(sample);
}

function DeferredHtmlBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div className="cedar-deferred-artifact">
      <div className="cedar-code-block">
        <div className="cedar-code-header">
          <span className="cedar-code-lang">{language || "html"}</span>
          <button
            type="button"
            className="cedar-copy-button"
            onClick={() => setPreviewOpen((open) => !open)}
          >
            {previewOpen ? "Hide preview" : "Preview"}
          </button>
        </div>
        {!previewOpen && (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
      {previewOpen && <ArtifactView language="html" code={code} />}
    </div>
  );
}

function PlainCodeBlock({
  language,
  code,
}: {
  language: string;
  code: string;
}) {
  return (
    <div className="cedar-code-block">
      <div className="cedar-code-header">
        <span className="cedar-code-lang">{language || "text"}</span>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ============================================================
// 块级渲染：标题、列表、段落、引用
// ============================================================

function renderMarkdownLines(text: string, blockIndex: number) {
  const lines = text.split("\n");
  const nodes: ReactNode[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];
  let blockquoteLines: string[] = [];

  function flushList(key: string) {
    if (listItems.length === 0) return;
    nodes.push(
      <ul key={key}>
        {listItems.map((item, i) => (
          <li key={i}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  function flushOrderedList(key: string) {
    if (orderedItems.length === 0) return;
    nodes.push(
      <ol key={key}>
        {orderedItems.map((item, i) => (
          <li key={i}>{renderInlineMarkdown(item)}</li>
        ))}
      </ol>,
    );
    orderedItems = [];
  }

  function flushBlockquote(key: string) {
    if (blockquoteLines.length === 0) return;
    nodes.push(
      <blockquote key={key}>
        {blockquoteLines.map((line, i) => (
          <p key={i}>{renderInlineMarkdown(line)}</p>
        ))}
      </blockquote>,
    );
    blockquoteLines = [];
  }

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // 无序列表
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      flushOrderedList(`${blockIndex}-ol-${index}`);
      flushBlockquote(`${blockIndex}-bq-${index}`);
      listItems.push(ulMatch[1]);
      return;
    }

    // 有序列表
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      flushList(`${blockIndex}-ul-${index}`);
      flushBlockquote(`${blockIndex}-bq-${index}`);
      orderedItems.push(olMatch[1]);
      return;
    }

    // 引用
    const bqMatch = trimmed.match(/^>\s?(.*)$/);
    if (bqMatch) {
      flushList(`${blockIndex}-ul-${index}`);
      flushOrderedList(`${blockIndex}-ol-${index}`);
      blockquoteLines.push(bqMatch[1]);
      return;
    }

    // 到这里说明当前行不是列表/引用，先刷新队列
    flushList(`${blockIndex}-ul-${index}`);
    flushOrderedList(`${blockIndex}-ol-${index}`);
    flushBlockquote(`${blockIndex}-bq-${index}`);

    // 空行
    if (!trimmed) {
      nodes.push(<div key={`${blockIndex}-blank-${index}`} className="h-2" />);
      return;
    }

    // 水平线
    if (/^[-*_]{3,}$/.test(trimmed)) {
      nodes.push(<hr key={`${blockIndex}-hr-${index}`} />);
      return;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      const key = `${blockIndex}-h-${index}`;
      if (level === 1) nodes.push(<h1 key={key}>{content}</h1>);
      else if (level === 2) nodes.push(<h2 key={key}>{content}</h2>);
      else if (level === 3) nodes.push(<h3 key={key}>{content}</h3>);
      else if (level === 4) nodes.push(<h4 key={key}>{content}</h4>);
      else if (level === 5) nodes.push(<h5 key={key}>{content}</h5>);
      else nodes.push(<h6 key={key}>{content}</h6>);
      return;
    }

    // 普通段落
    nodes.push(
      <p key={`${blockIndex}-p-${index}`}>{renderInlineMarkdown(line)}</p>,
    );
  });

  // 文件末尾可能还有未刷新的列表
  flushList(`${blockIndex}-ul-end`);
  flushOrderedList(`${blockIndex}-ol-end`);
  flushBlockquote(`${blockIndex}-bq-end`);

  return nodes;
}

// ============================================================
// 行内渲染：加粗、斜体、删除线、code、链接
// ============================================================

function renderInlineMarkdown(text: string): ReactNode[] {
  // 正则按优先级匹配行内元素
  // 顺序很重要：先匹配长的（**）再匹配短的（*）
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[([^\]]+)\]\(([^)]+)\))/g;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // 匹配前的纯文本
    if (match.index > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>);
    }

    const token = match[0];

    if (token.startsWith("`") && token.endsWith("`")) {
      // 行内代码
      parts.push(<code key={`c-${match.index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      // 加粗
      parts.push(<strong key={`b-${match.index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      // 删除线
      parts.push(<del key={`d-${match.index}`}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      // 斜体
      parts.push(<em key={`i-${match.index}`}>{token.slice(1, -1)}</em>);
    } else if (match[2] && match[3]) {
      // 链接 [text](url)
      parts.push(
        <a key={`a-${match.index}`} href={match[3]} target="_blank" rel="noopener noreferrer">
          {match[2]}
        </a>,
      );
    }

    lastIndex = match.index + token.length;
  }

  // 剩余纯文本
  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  return parts.length > 0 ? parts : [<span key="full">{text}</span>];
}
