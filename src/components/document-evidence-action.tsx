"use client";

import { Eye, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { EvidenceReviewPreview } from "@/lib/domain/types";

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

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !acting) setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [acting, open]);

  async function inspect() {
    setOpen(true);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/documents/${documentId}/evidence`);
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok || !payload.data) {
        throw new Error(
          payload.error?.message ?? "근거를 불러오지 못했습니다.",
        );
      }
      setPreview(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "근거 조회 실패");
    } finally {
      setLoading(false);
    }
  }

  async function decide(decision: "APPROVED" | "REJECTED") {
    if (!preview) return;
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
        <Eye size={14} aria-hidden="true" /> 근거 검토
      </button>
      {open ? (
        <div className="evidence-modal-backdrop" role="presentation">
          <section
            className="evidence-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`evidence-review-title-${documentId}`}
          >
            <header className="evidence-modal-header">
              <div>
                <span className="eyebrow">Checksum-bound review</span>
                <h2 id={`evidence-review-title-${documentId}`}>
                  AI 근거 적합성 검토
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="근거 검토 닫기"
                disabled={Boolean(acting)}
                onClick={() => setOpen(false)}
                autoFocus
              >
                <X size={16} />
              </button>
            </header>

            {loading ? (
              <div className="evidence-modal-loading" role="status">
                <LoaderCircle className="spin" size={20} /> 추출 근거를 불러오는
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
                    <span>업로더 / 버전</span>
                    <strong>
                      {preview.uploadedBy} / v{preview.version}
                    </strong>
                  </div>
                  {preview.sourcePublisher ? (
                    <div>
                      <span>공식 발행기관 / 취득일</span>
                      <strong>
                        {preview.sourcePublisher} /{" "}
                        {preview.acquiredAt?.slice(0, 10) ?? "—"}
                      </strong>
                    </div>
                  ) : null}
                  {preview.sourceUri ? (
                    <div className="evidence-checksum-row">
                      <span>공식 원문</span>
                      <a
                        href={preview.sourceUri}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {preview.sourceUri}
                      </a>
                    </div>
                  ) : null}
                  <div className="evidence-checksum-row">
                    <span>승인에 고정되는 SHA-256</span>
                    <code>{preview.checksumSha256}</code>
                  </div>
                  <div className="evidence-checksum-row">
                    <span>현재 추출본 manifest SHA-256</span>
                    <code>{preview.manifestSha256}</code>
                  </div>
                </div>
                <p className="evidence-review-notice">
                  아래에는 현재 버전의 추출 내용을 전부 표시합니다. 승인 시 원본
                  체크섬과 전체 청크 manifest가 함께 검증되며, 변경된 문서는
                  승인되지 않습니다.
                </p>
                <div className="evidence-preview-list">
                  {preview.previewChunks.map((chunk) => (
                    <article key={chunk.id}>
                      <header>
                        <strong>{chunk.section ?? "구간"}</strong>
                        <span>
                          {chunk.page ? `${chunk.page}쪽 · ` : ""}
                          {chunk.contentHash.slice(0, 12)}
                        </span>
                      </header>
                      <small className="evidence-temporal-scope">
                        {chunk.sourceType === "BUSINESS_RECORD"
                          ? "업무 증빙"
                          : chunk.sourceType === "TAX_AUTHORITY"
                            ? "세법·공식 자료"
                            : "내부 정책"}
                        {` · ${chunk.jurisdiction}`}
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
                  전체 {preview.chunkCount.toLocaleString("ko-KR")}개 청크를
                  모두 표시합니다.
                </small>
              </>
            ) : null}

            {error ? (
              <p role="alert" className="form-error">
                {error}
              </p>
            ) : null}
            <footer className="evidence-modal-actions">
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
                )}
                근거 제외
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
                )}
                AI 근거로 승인
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
