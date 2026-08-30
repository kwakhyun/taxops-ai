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
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Matter } from "@/lib/domain/types";

type UploadResult = {
  name: string;
  status: "uploading" | "queued" | "error";
  detail: string;
};

export function UploadPanel({
  matterId,
  canIngestAuthority = false,
  matters = [],
  onBusyChange,
}: {
  matterId?: string;
  canIngestAuthority?: boolean;
  matters?: Pick<Matter, "id" | "client" | "taxType" | "period">[];
  onBusyChange?: (busy: boolean) => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const [selectedMatterId, setSelectedMatterId] = useState(matterId ?? "");
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<UploadResult>();
  const [sourceType, setSourceType] = useState<
    "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY"
  >("BUSINESS_RECORD");
  const [sourcePublisher, setSourcePublisher] = useState("");
  const [sourceUri, setSourceUri] = useState("");
  const busy = result?.status === "uploading";
  const targetMatterId = matterId ?? selectedMatterId;

  async function upload(file: File) {
    if (uploadLock.current) return;
    if (!targetMatterId) {
      setResult({
        name: file.name,
        status: "error",
        detail: "먼저 자료를 연결할 세무 업무를 선택해 주세요.",
      });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setResult({
        name: file.name,
        status: "error",
        detail: "파일당 최대 15 MB까지 업로드할 수 있습니다.",
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
    uploadLock.current = true;
    onBusyChange?.(true);
    setResult({ name: file.name, status: "uploading", detail: "파일 검증 중" });
    const formData = new FormData();
    formData.set("file", file);
    formData.set("matterId", targetMatterId);
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
          : `보안 검사 작업 ${payload.data.job.id.slice(-8)}이 대기열에 추가됐습니다.`,
      });
      router.refresh();
    } catch (cause) {
      setResult({
        name: file.name,
        status: "error",
        detail:
          cause instanceof Error ? cause.message : "업로드하지 못했습니다.",
      });
    } finally {
      uploadLock.current = false;
      onBusyChange?.(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section
      className="upload-panel"
      id="upload-panel"
      aria-label="세무 자료 업로드"
    >
      {!matterId ? (
        <div className="upload-matter-picker">
          <label className="upload-source-field">
            <span>연결할 세무 업무</span>
            <select
              value={selectedMatterId}
              disabled={busy}
              onChange={(event) => setSelectedMatterId(event.target.value)}
            >
              <option value="">세무 업무를 선택해 주세요</option>
              {matters.map((matter) => (
                <option key={matter.id} value={matter.id}>
                  {matter.client} · {matter.taxType} · {matter.period}
                </option>
              ))}
            </select>
          </label>
          <p>
            {matters.length ? (
              "업무를 선택하면 해당 업무에 자료가 연결됩니다."
            ) : (
              <>
                등록된 업무가 없습니다.{" "}
                <Link href="/cases/new">새 업무를 등록해 주세요.</Link>
              </>
            )}
          </p>
        </div>
      ) : null}
      <label className="upload-source-field">
        <span>자료 유형</span>
        <select
          disabled={busy}
          value={sourceType}
          onChange={(event) =>
            setSourceType(
              event.target.value as
                "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY",
            )
          }
        >
          <option value="BUSINESS_RECORD">고객사 자료</option>
          {canIngestAuthority ? (
            <option value="TAX_AUTHORITY">세법령·공식 자료</option>
          ) : null}
          <option value="INTERNAL_POLICY">내부 지침</option>
        </select>
      </label>
      {sourceType === "TAX_AUTHORITY" ? (
        <div className="upload-authority-fields">
          <label className="upload-source-field">
            <span>발행기관</span>
            <input
              disabled={busy}
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
              disabled={busy}
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
          if (uploadLock.current) return;
          const files = event.dataTransfer.files;
          if (files.length > 1) {
            setResult({
              name: "파일 선택",
              status: "error",
              detail: "한 번에 파일 1개씩 업로드해 주세요.",
            });
          } else if (files[0]) void upload(files[0]);
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
          disabled={!targetMatterId || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "업로드 중" : "파일 선택"}
        </button>
        <input
          className="sr-only"
          aria-label="업로드할 세무 자료 선택"
          ref={inputRef}
          type="file"
          disabled={!targetMatterId || busy}
          accept=".pdf,.docx,.xlsx,.csv,.txt"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
      </div>
      <div className="upload-security">
        <ShieldCheck size={14} />
        <span>
          업로드한 파일은 별도 공간에 보관됩니다. 파일 형식, 무결성, 악성코드
          검사를 통과한 자료만 검색 근거로 사용할 수 있습니다.
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
            disabled={busy}
            onClick={() => setResult(undefined)}
          >
            <X size={15} />
          </button>
        </div>
      ) : null}
    </section>
  );
}
