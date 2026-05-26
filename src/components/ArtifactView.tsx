// src/components/ArtifactView.tsx
//
// Artifact 预览组件 - 代码块智能渲染
// 支持：HTML预览、React组件预览、Mermaid图表、SVG、普通代码高亮+复制+全屏

import { useState, useEffect, useRef } from "react";

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, chart: string) => Promise<{ svg: string }>;
}

// ============================================================
// 复制按钮
// ============================================================

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button onClick={handleCopy} className="cedar-copy-button">
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

// ============================================================
// 全屏按钮
// ============================================================

function FullscreenButton({ isFullscreen, onToggle }: { isFullscreen: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="cedar-copy-button" title={isFullscreen ? "退出全屏" : "全屏"}>
      {isFullscreen ? "✕ Exit" : "⛶ Full"}
    </button>
  );
}

// ============================================================
// HTML 预览
// ============================================================

function HtmlPreview({ code }: { code: string }) {
  const [showPreview, setShowPreview] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const srcDoc = code.includes("<html") || code.includes("<!DOCTYPE")
    ? code
    : `<!DOCTYPE html><html><head><meta charset="utf-8">
       <style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;padding:16px;margin:0;color:#1a1a1a;}</style>
       </head><body>${code}</body></html>`;

  return (
    <div className={`cedar-artifact-container ${isFullscreen ? "cedar-fullscreen" : ""}`}>
      <div className="cedar-artifact-header">
        <span className="cedar-code-lang">HTML</span>
        <div className="cedar-artifact-tabs">
          <button
            className={`cedar-artifact-tab ${showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(true)}
          >
            Preview
          </button>
          <button
            className={`cedar-artifact-tab ${!showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(false)}
          >
            Code
          </button>
        </div>
        <FullscreenButton isFullscreen={isFullscreen} onToggle={() => setIsFullscreen(!isFullscreen)} />
        <CopyButton code={code} />
      </div>
      {showPreview ? (
        <iframe
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-modals allow-forms"
          className="cedar-artifact-frame"
        />
      ) : (
        <pre className="cedar-artifact-code"><code>{code}</code></pre>
      )}
    </div>
  );
}

// ============================================================
// React/JSX 预览
// ============================================================

function ReactPreview({ code }: { code: string }) {
  const [showPreview, setShowPreview] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 检测是否有 export default 或 function App / const App
  let entryCode = code;
  // 移除 import 语句（iframe 里用 UMD）
  entryCode = entryCode.replace(/^import\s+.*?['";\n]/gm, "");
  // 如果有 export default，替换为赋值
  entryCode = entryCode.replace(/export\s+default\s+/, "const __DefaultExport__ = ");

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<script src="https://unpkg.com/react@19/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@19/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://cdn.tailwindcss.com"></script>
<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:16px;}</style>
</head><body>
<div id="root"></div>
<script type="text/babel">
const { useState, useEffect, useRef, useMemo, useCallback, Fragment } = React;
${entryCode}

// 尝试多种入口名
const Entry = typeof App !== 'undefined' ? App
  : typeof __DefaultExport__ !== 'undefined' ? __DefaultExport__
  : typeof Component !== 'undefined' ? Component
  : () => React.createElement('div', null, 'No App/Component found');

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Entry));
</script>
</body></html>`;

  return (
    <div className={`cedar-artifact-container ${isFullscreen ? "cedar-fullscreen" : ""}`}>
      <div className="cedar-artifact-header">
        <span className="cedar-code-lang">React</span>
        <div className="cedar-artifact-tabs">
          <button
            className={`cedar-artifact-tab ${showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(true)}
          >
            Preview
          </button>
          <button
            className={`cedar-artifact-tab ${!showPreview ? "active" : ""}`}
            onClick={() => setShowPreview(false)}
          >
            Code
          </button>
        </div>
        <FullscreenButton isFullscreen={isFullscreen} onToggle={() => setIsFullscreen(!isFullscreen)} />
        <CopyButton code={code} />
      </div>
      {showPreview ? (
        <iframe
          srcDoc={html}
          sandbox="allow-scripts allow-modals allow-forms"
          className="cedar-artifact-frame"
        />
      ) : (
        <pre className="cedar-artifact-code"><code>{code}</code></pre>
      )}
    </div>
  );
}

// ============================================================
// Mermaid 图表
// ============================================================

function MermaidDiagram({ chart }: { chart: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;

    // 动态加载 mermaid（避免打包体积太大）
    const script = document.querySelector('script[src*="mermaid"]') as HTMLScriptElement | null;
    const load = script
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
          s.onload = () => resolve();
          document.head.appendChild(s);
        });

    load.then(async () => {
      if (cancelled) return;
      try {
        const mermaid = (window as Window & { mermaid?: MermaidApi }).mermaid;
        if (!mermaid) throw new Error("Mermaid 加载失败");
        mermaid.initialize({ startOnLoad: false, theme: "dark" });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, chart);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        if (!cancelled) setError(message || "Mermaid 渲染失败");
      }
    });

    return () => { cancelled = true; };
  }, [chart]);

  return (
    <div className={`cedar-artifact-container ${isFullscreen ? "cedar-fullscreen" : ""}`}>
      <div className="cedar-artifact-header">
        <span className="cedar-code-lang">Mermaid</span>
        <div className="cedar-artifact-tabs">
          <button
            className={`cedar-artifact-tab ${!showCode ? "active" : ""}`}
            onClick={() => setShowCode(false)}
          >
            Diagram
          </button>
          <button
            className={`cedar-artifact-tab ${showCode ? "active" : ""}`}
            onClick={() => setShowCode(true)}
          >
            Code
          </button>
        </div>
        <FullscreenButton isFullscreen={isFullscreen} onToggle={() => setIsFullscreen(!isFullscreen)} />
        <CopyButton code={chart} />
      </div>
      {showCode ? (
        <pre className="cedar-artifact-code"><code>{chart}</code></pre>
      ) : error ? (
        <div className="cedar-alert" style={{ margin: "0.5rem" }}>{error}</div>
      ) : (
        <div ref={ref} className="cedar-mermaid" />
      )}
    </div>
  );
}

// ============================================================
// SVG 预览
// ============================================================

function SvgPreview({ svg }: { svg: string }) {
  const [showCode, setShowCode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <div className={`cedar-artifact-container ${isFullscreen ? "cedar-fullscreen" : ""}`}>
      <div className="cedar-artifact-header">
        <span className="cedar-code-lang">SVG</span>
        <div className="cedar-artifact-tabs">
          <button
            className={`cedar-artifact-tab ${!showCode ? "active" : ""}`}
            onClick={() => setShowCode(false)}
          >
            Preview
          </button>
          <button
            className={`cedar-artifact-tab ${showCode ? "active" : ""}`}
            onClick={() => setShowCode(true)}
          >
            Code
          </button>
        </div>
        <FullscreenButton isFullscreen={isFullscreen} onToggle={() => setIsFullscreen(!isFullscreen)} />
        <CopyButton code={svg} />
      </div>
      {showCode ? (
        <pre className="cedar-artifact-code"><code>{svg}</code></pre>
      ) : (
        <div className="cedar-svg-preview" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </div>
  );
}

// ============================================================
// 普通代码块（带高亮+复制+全屏）
// ============================================================

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  return (
    <div className={`cedar-code-block ${isFullscreen ? "cedar-fullscreen" : ""}`}>
      <div className="cedar-code-header">
        <span className="cedar-code-lang">{language || "text"}</span>
        <FullscreenButton isFullscreen={isFullscreen} onToggle={() => setIsFullscreen(!isFullscreen)} />
        <CopyButton code={code} />
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

// ============================================================
// 主入口：根据语言自动选择渲染方式
// ============================================================

export function ArtifactView({ language, code }: { language: string; code: string }) {
  const lang = language.toLowerCase();

  // HTML 预览
  if (lang === "html" || lang === "htm") {
    return <HtmlPreview code={code} />;
  }

  // React/JSX 预览
  if (lang === "jsx" || lang === "tsx" || lang === "react") {
    return <ReactPreview code={code} />;
  }

  // Mermaid 图表
  if (lang === "mermaid") {
    return <MermaidDiagram chart={code} />;
  }

  // SVG 预览
  if (lang === "svg") {
    return <SvgPreview svg={code} />;
  }

  // 普通代码块
  return <CodeBlock language={language} code={code} />;
}
