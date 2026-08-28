"use client";

import {
  CheckCircle2,
  FileUp,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

type UploadResult = {
  name: string;
  status: "uploading" | "queued" | "error";
  detail: string;
};

export function UploadPanel({
  matterId,
  canIngestAuthority = false,
}: {
  matterId?: string;
  canIngestAuthority?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<UploadResult>();
  const [sourceType, setSourceType] = useState<
    "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY"
  >("BUSINESS_RECORD");
  const [sourcePublisher, setSourcePublisher] = useState("");
  const [sourceUri, setSourceUri] = useState("");

  async function upload(file: File) {
    if (!matterId) {
      setResult({
        name: file.name,
        status: "error",
        detail: "먼저 자료를 연결할 케이스를 생성해 주세요.",
      });
      return;
    }
    if (
      sourceType === "TAX_AUTHORITY" &&
      (!sourcePublisher.trim() || !sourceUri.trim())
    ) {
      setResult({
        name: file.name,
        status: "error",
        detail: "공식 자료의 발행기관과 HTTPS 원문 주소를 입력해 주세요.",
      });
      return;
    }
    setResult({ name: file.name, status: "uploading", detail: "파일 검증 중" });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("matterId", matterId);
    formData.set("sourceType", sourceType);
    if (sourceType === "TAX_AUTHORITY") {
      formData.set("sourcePublisher", sourcePublisher);
      formData.set("sourceUri", sourceUri);
    }

    try {
      const response = await fetch("/api/v1/uploads", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: formData,
      });
      const payload = (await response.json()) as {
        data?: { job: { id: string }; deduplicated: boolean };
        error?: { message: string };
      };
      if (!response.ok || !payload.data)
        throw new Error(payload.error?.message ?? "업로드 실패");
      setResult({
        name: file.name,
        status: "queued",
        detail: payload.data.deduplicated
          ? "동일한 파일이 이미 처리 대기 중입니다."
          : `검역 작업 ${payload.data.job.id.slice(-8)}이 대기열에 추가됐습니다.`,
      });
    } catch (cause) {
      setResult({
        name: file.name,
        status: "error",
        detail:
          cause instanceof Error ? cause.message : "업로드하지 못했습니다.",
      });
    }
  }

  return (
    <section className="upload-panel">
      <label className="upload-source-field">
        <span>자료 성격</span>
        <select
          value={sourceType}
          onChange={(event) =>
            setSourceType(
              event.target.value as
                "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY",
            )
          }
        >
          <option value="BUSINESS_RECORD">업무 증빙</option>
          {canIngestAuthority ? (
            <option value="TAX_AUTHORITY">세법·공식 자료</option>
          ) : null}
          <option value="INTERNAL_POLICY">내부 정책</option>
        </select>
      </label>
      {sourceType === "TAX_AUTHORITY" ? (
        <div className="upload-authority-fields">
          <label className="upload-source-field">
            <span>발행기관</span>
            <input
              required
              maxLength={200}
              value={sourcePublisher}
              onChange={(event) => setSourcePublisher(event.target.value)}
              placeholder="예: 국가법령정보센터"
            />
          </label>
          <label className="upload-source-field">
            <span>공식 원문 주소</span>
            <input
              required
              type="url"
              maxLength={2000}
              value={sourceUri}
              onChange={(event) => setSourceUri(event.target.value)}
              placeholder="https://..."
            />
          </label>
        </div>
      ) : null}
      <div
        className={`upload-dropzone ${dragging ? "upload-dropzone-active" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) void upload(file);
        }}
      >
        <span className="upload-icon">
          <FileUp size={23} />
        </span>
        <div>
          <strong>파일을 놓거나 선택해 업로드</strong>
          <p>PDF, DOCX, XLSX, CSV, TXT · 파일당 최대 15 MB</p>
        </div>
        <button
          className="button button-secondary button-compact"
          type="button"
          disabled={!matterId}
          onClick={() => inputRef.current?.click()}
        >
          파일 선택
        </button>
        <input
          className="sr-only"
          aria-label="업로드할 세무 자료 선택"
          ref={inputRef}
          type="file"
          accept=".pdf,.docx,.xlsx,.csv,.txt"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>
      <div className="upload-security">
        <ShieldCheck size={14} />
        <span>
          업로드 즉시 격리됩니다. MIME·파일 서명·체크섬·악성 파일 검사를
          통과해야 검색할 수 있습니다.
        </span>
      </div>
      {result ? (
        <div
          className={`upload-result upload-result-${result.status}`}
          role="status"
        >
          {result.status === "uploading" ? (
            <LoaderCircle className="spin" size={17} />
          ) : null}
          {result.status === "queued" ? <CheckCircle2 size={17} /> : null}
          {result.status === "error" ? <TriangleAlert size={17} /> : null}
          <div>
            <strong>{result.name}</strong>
            <span>{result.detail}</span>
          </div>
          <button
            type="button"
            aria-label="업로드 상태 닫기"
            onClick={() => setResult(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
    </section>
  );
}
