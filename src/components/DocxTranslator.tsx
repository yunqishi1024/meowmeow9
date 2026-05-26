// src/components/DocxTranslator.tsx
//
// Word 文档翻译 UI 组件

import { useState, useRef } from "react";
import { translateDocx, downloadBlob } from "../lib/docxTranslate";

interface DocxTranslatorProps {
  baseUrl: string;
  apiKey: string;
  model: string;
  onClose?: () => void;
}

export function DocxTranslator({ baseUrl, apiKey, model, onClose }: DocxTranslatorProps) {
  const [file, setFile] = useState<File | null>(null);
  const [targetLang, setTargetLang] = useState("英文");
  const [status, setStatus] = useState<"idle" | "translating" | "done" | "error">("idle");
  const [progress, setProgress] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && selected.name.endsWith(".docx")) {
      setFile(selected);
      setStatus("idle");
      setErrorMsg("");
    } else if (selected) {
      setErrorMsg("请选择 .docx 格式的 Word 文档");
    }
  };

  const handleTranslate = async () => {
    if (!file) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("translating");
    setProgress("解析文档...");
    setErrorMsg("");

    try {
      const result = await translateDocx(file, {
        targetLang,
        baseUrl,
        apiKey,
        model,
        signal: controller.signal,
        onProgress: (done, total) => {
          setProgress(`翻译中... ${done}/${total} 段`);
        },
      });

      setStatus("done");
      setProgress(`完成！共翻译 ${result.paragraphCount} 段`);
      downloadBlob(result.blob, result.filename);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError" || message === "翻译已取消") {
        setStatus("idle");
        setProgress("已取消");
      } else {
        setStatus("error");
        setErrorMsg(message || "翻译失败");
      }
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="cedar-docx-translator">
      <div className="cedar-docx-header">
        <span className="cedar-docx-title">Word 文档翻译（保留格式）</span>
        {onClose && (
          <button className="cedar-icon-button" onClick={onClose} style={{ width: "1.5rem", height: "1.5rem", flexBasis: "1.5rem", border: 0 }}>
            ×
          </button>
        )}
      </div>

      <div className="cedar-docx-body">
        <div className="cedar-docx-row">
          <button className="cedar-button" onClick={() => fileInputRef.current?.click()}>
            选择 .docx 文件
          </button>
          <span className="cedar-docx-filename">
            {file ? file.name : "未选择"}
          </span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            onChange={handleFileChange}
            style={{ display: "none" }}
          />
        </div>

        <div className="cedar-docx-row">
          <label className="cedar-docx-label">翻译为：</label>
          <select
            className="select"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            style={{ width: "auto" }}
          >
            <option value="英文">英文</option>
            <option value="中文">中文</option>
            <option value="日文">日文</option>
            <option value="韩文">韩文</option>
            <option value="法文">法文</option>
            <option value="德文">德文</option>
            <option value="西班牙文">西班牙文</option>
            <option value="俄文">俄文</option>
          </select>
        </div>

        <div className="cedar-docx-row">
          {status === "translating" ? (
            <button className="cedar-stop-button" onClick={handleCancel}>取消</button>
          ) : (
            <button className="cedar-button" onClick={handleTranslate} disabled={!file || !apiKey}>
              开始翻译
            </button>
          )}
          {progress && <span className="cedar-docx-progress">{progress}</span>}
        </div>

        {errorMsg && <div className="cedar-alert">{errorMsg}</div>}
      </div>
    </div>
  );
}
