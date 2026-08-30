"use client";

import { Eye, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/dialog";
import type { EvidenceReviewPreview } from "@/lib/domain/types";
import { jurisdictionLabel, sourceTypeLabel } from "@/lib/ui/labels";

interface ApiPayload {
  data?: EvidenceReviewPreview;
  error?: { message?: string };
}

export function DocumentEvidenceAction({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<"APPROVED" | "REJECTED">();
  const [preview, setPreview] = useState<EvidenceReviewPreview>();
  const [error, setError] = useState("");
  const previewRequest = useRef<AbortController | null>(null);
  const decisionLock = useRef(false);

  useEffect(() => () => previewRequest.current?.abort(), []);

  function close() {
    if (decisionLock.current) return;
    previewRequest.current?.abort();
    setOpen(false);
  }

  async function inspect() {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    const timeout = window.setTimeout(
      () =>
        controller.abort(new DOMException("Preview timed out", "TimeoutError")),
      30_000,
    );
    setOpen(true);
    setLoading(true);
    setPreview(undefined);
    setError("");
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/evidence`, {
        signal: controller.signal,
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok || !payload.data) {
        throw new Error(
          payload.error?.message ?? "근거를 불러오지 못했습니다.",
        );
      }
      if (!controller.signal.aborted) setPreview(payload.data);
    } catch (cause) {
      if (
        controller.signal.aborted &&
        controller.signal.reason?.name !== "TimeoutError"
      )
        return;
      setError(
        cause instanceof Error && /[가-힣]/.test(cause.message)
          ? cause.message
          : "근거를 불러오지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (previewRequest.current === controller) setLoading(false);
    }
  }

  async function decide(decision: "APPROVED" | "REJECTED") {
    if (!preview || decisionLock.current) return;
    decisionLock.current = true;
    setActing(decision);
    setError("");
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/evidence`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          checksumSha256: preview.checksumSha256,
          manifestSha256: preview.manifestSha256,
        }),
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) {
        throw new Error(payload.error?.message ?? "근거 검토에 실패했습니다.");
      }
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "근거 검토 실패");
    } finally {
      decisionLock.current = false;
      setActing(undefined);
    }
  }

  return (
    <>
      <button
        type="button"
        className="button button-secondary button-compact evidence-review-button"
        onClick={() => void inspect()}
      >
        <Eye size={14} aria-hidden="true" /> 검색 근거 검토
      </button>
      <Dialog
        open={open}
        title="AI 검색 근거 검토"
        onClose={close}
        closeDisabled={Boolean(acting)}
        closeLabel="근거 검토 닫기"
        footer={
          <div className="evidence-modal-actions">
            <button
              type="button"
              className="button button-danger"
              disabled={!preview || Boolean(acting)}
              onClick={() => void decide("REJECTED")}
            >
              {acting === "REJECTED" ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <X size={15} />
              )}{" "}
              사용 제외
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!preview || Boolean(acting)}
              onClick={() => void decide("APPROVED")}
            >
              {acting === "APPROVED" ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <ShieldCheck size={15} />
              )}{" "}
              검색 근거로 승인
            </button>
          </div>
        }
      >
        {loading ? (
          <div className="evidence-modal-loading" role="status">
            <LoaderCircle className="spin" size={20} /> 추출 내용을 불러오는
            중입니다.
          </div>
        ) : preview ? (
          <>
            <div className="evidence-review-summary">
              <div>
                <span>문서</span>
                <strong>{preview.name}</strong>
              </div>
              <div>
                <span>등록자 · 버전</span>
                <strong>
                  {preview.uploadedBy} · v{preview.version}
                </strong>
              </div>
              {preview.sourcePublisher ? (
                <div>
                  <span>공식 발행기관 · 수집일</span>
                  <strong>
                    {preview.sourcePublisher} ·{" "}
                    {preview.acquiredAt?.slice(0, 10) ?? "—"}
                  </strong>
                </div>
              ) : null}
              {preview.sourceUri ? (
                <div className="evidence-checksum-row">
                  <span>공식 원문</span>
                  <a href={preview.sourceUri} rel="noreferrer" target="_blank">
                    {preview.sourceUri}
                  </a>
                </div>
              ) : null}
              <div className="evidence-checksum-row">
                <span>원본 파일 해시(SHA-256)</span>
                <code>{preview.checksumSha256}</code>
              </div>
              <div className="evidence-checksum-row">
                <span>추출 내용 해시(SHA-256)</span>
                <code>{preview.manifestSha256}</code>
              </div>
            </div>
            <p className="evidence-review-notice">
              현재 버전에서 추출한 내용을 모두 표시합니다. 승인 시 시스템이 원본
              파일과 추출 내용의 해시를 다시 대조합니다. 승인 후 변경된 자료는
              검색 근거에서 자동으로 제외됩니다.
            </p>
            <div className="evidence-preview-list">
              {preview.previewChunks.map((chunk) => (
                <article key={chunk.id}>
                  <header>
                    <strong>{chunk.section ?? "구간"}</strong>
                    <span>
                      {chunk.page ? `${chunk.page}쪽 · ` : ""}
                      내용 해시 {chunk.contentHash.slice(0, 12)}…
                    </span>
                  </header>
                  <small className="evidence-temporal-scope">
                    {sourceTypeLabel(chunk.sourceType)}
                    {` · ${jurisdictionLabel(chunk.jurisdiction)}`}
                    {chunk.effectiveFrom
                      ? ` · ${chunk.effectiveFrom.slice(0, 10)}부터`
                      : ""}
                    {chunk.effectiveTo
                      ? ` ${chunk.effectiveTo.slice(0, 10)} 전까지`
                      : ""}
                  </small>
                  <p>{chunk.excerpt}</p>
                </article>
              ))}
            </div>
            <small>
              검색용 문서 구간 {preview.chunkCount.toLocaleString("ko-KR")}개를
              모두 표시합니다.
            </small>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        {error && !preview && !loading ? (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => void inspect()}
          >
            다시 불러오기
          </button>
        ) : null}
      </Dialog>
    </>
  );
}
