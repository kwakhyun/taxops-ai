"use client";

import {
  Check,
  CheckCircle2,
  ChevronRight,
  FileCheck2,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { ReviewRequest } from "@/lib/workpapers/artifact";

type Decision = {
  decision: "APPROVED" | "REJECTED";
  reviewer: string;
  note: string;
};

function textList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function displayValue(value: unknown) {
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

type EvidenceSnapshot = {
  id: string;
  documentName: string;
  page?: number | null;
  section?: string | null;
  excerpt: string;
  contentHash: string;
};

function evidenceSnapshots(value: unknown): EvidenceSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is EvidenceSnapshot =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as EvidenceSnapshot).id === "string" &&
      typeof (item as EvidenceSnapshot).documentName === "string" &&
      typeof (item as EvidenceSnapshot).excerpt === "string" &&
      typeof (item as EvidenceSnapshot).contentHash === "string",
  );
}

export function ReviewWorkspace({
  requests,
  reviewerName,
}: {
  requests: ReviewRequest[];
  reviewerName: string;
}) {
  const [selectedId, setSelectedId] = useState(requests[0]?.targetId);
  const [acting, setActing] = useState<"APPROVED" | "REJECTED">();
  const [decision, setDecision] = useState<Decision>();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState(
    "현재 버전의 내용과 provenance 해시를 확인한 뒤 결정이 기록됩니다.",
  );
  const selected = useMemo(
    () => requests.find((item) => item.targetId === selectedId),
    [requests, selectedId],
  );

  async function decide(nextDecision: "APPROVED" | "REJECTED") {
    if (!selected) return;
    const normalizedNote = note.trim();
    if (normalizedNote.length < 4) {
      setMessage("검토 근거가 남도록 의견을 4자 이상 입력해 주세요.");
      return;
    }
    setActing(nextDecision);
    setMessage("");
    try {
      const tokenResponse = await fetch("/api/v1/reviews/" + selected.targetId);
      const tokenPayload = (await tokenResponse.json()) as {
        data?: {
          tokens?: Record<"APPROVED" | "REJECTED", string>;
          artifactHash?: string;
          decision?: Decision;
        };
        error?: { message: string };
      };
      if (tokenPayload.data?.decision) {
        setDecision(tokenPayload.data.decision);
        setMessage("이미 처리된 검토 요청입니다.");
        return;
      }
      if (
        !tokenResponse.ok ||
        !tokenPayload.data?.tokens?.[nextDecision] ||
        !tokenPayload.data.artifactHash
      ) {
        throw new Error(tokenPayload.error?.message ?? "승인 토큰 발급 실패");
      }
      const response = await fetch("/api/v1/reviews/" + selected.targetId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: nextDecision,
          note: normalizedNote,
          token: tokenPayload.data.tokens[nextDecision],
          artifactHash: tokenPayload.data.artifactHash,
        }),
      });
      const payload = (await response.json()) as {
        data?: Decision;
        error?: { message: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "검토 처리 실패");
      }
      setDecision(payload.data);
      setMessage(
        nextDecision === "APPROVED"
          ? "워크페이퍼를 승인했습니다."
          : "워크페이퍼를 반려했습니다.",
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "검토 결정을 저장하지 못했습니다.",
      );
    } finally {
      setActing(undefined);
    }
  }

  if (!selected) {
    return (
      <section className="card empty-state">
        <FileCheck2 size={24} />
        <h2>배정된 검토 요청이 없습니다.</h2>
        <p>검증을 통과한 워크페이퍼가 제출되면 이곳에 표시됩니다.</p>
      </section>
    );
  }

  const conclusion =
    typeof selected.content.conclusion === "string"
      ? selected.content.conclusion
      : "결론이 기록되지 않았습니다.";
  const legacyCalculation =
    selected.content.calculation &&
    typeof selected.content.calculation === "object" &&
    !Array.isArray(selected.content.calculation)
      ? Object.entries(selected.content.calculation)
      : [];
  const calculations = Array.isArray(selected.content.calculations)
    ? selected.content.calculations.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : legacyCalculation.length
      ? [Object.fromEntries(legacyCalculation)]
      : [];
  const evidence = evidenceSnapshots(selected.content.evidence);
  const evidenceIds = evidence.length
    ? evidence.map((item) => item.id)
    : textList(selected.content.evidenceIds);
  const openItems = textList(selected.content.openItems);

  return (
    <div className="review-layout">
      <section className="review-inbox card">
        <div className="card-header">
          <div>
            <span className="card-kicker">검토 대기열</span>
            <h2>
              검토 대기{" "}
              {requests.filter((item) => item.status === "PENDING").length}건
            </h2>
          </div>
        </div>
        <div className="review-list">
          {requests.map((request) => (
            <button
              className={
                "review-list-item " +
                (request.targetId === selected.targetId
                  ? "review-list-item-active"
                  : "")
              }
              key={request.targetId}
              type="button"
              onClick={() => {
                setSelectedId(request.targetId);
                setDecision(undefined);
                setNote("");
              }}
            >
              <span className="review-list-icon">
                <FileCheck2 size={17} />
              </span>
              <span>
                <strong>
                  {request.client} / {request.title}
                </strong>
                <small>
                  워크페이퍼 v{request.version} / {request.requestedBy}
                </small>
              </span>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      </section>

      <section className="review-document card">
        <div className="review-document-header">
          <div>
            <span className="card-kicker">워크페이퍼 v{selected.version}</span>
            <h1>{selected.title}</h1>
            <p>
              {selected.client} / {selected.period} {selected.taxType}
            </p>
          </div>
          <span
            className={
              "status-pill " +
              (selected.stale ||
              (decision?.decision ?? selected.status) === "REJECTED"
                ? "status-danger"
                : (decision?.decision ?? selected.status) === "APPROVED"
                  ? "status-success"
                  : "status-warning")
            }
          >
            {selected.stale
              ? "버전 변경"
              : (decision?.decision ?? selected.status) === "APPROVED"
                ? "승인 완료"
                : (decision?.decision ?? selected.status) === "REJECTED"
                  ? "반려 완료"
                  : "승인 대기"}
          </span>
        </div>
        <div className="review-document-body">
          <section>
            <span className="review-section-number">01</span>
            <div>
              <h2>검토 결론</h2>
              <p>{conclusion}</p>
            </div>
          </section>
          <section>
            <span className="review-section-number">02</span>
            <div>
              <h2>계산 결과</h2>
              <div className="calculation-box">
                {calculations.length ? (
                  calculations.flatMap((calculation, calculationIndex) =>
                    Object.entries(calculation).map(([label, value]) => (
                      <div key={calculationIndex + "-" + label}>
                        <span>{label}</span>
                        <strong>{displayValue(value)}</strong>
                      </div>
                    )),
                  )
                ) : (
                  <p>저장된 계산 결과가 없습니다.</p>
                )}
              </div>
            </div>
          </section>
          <section>
            <span className="review-section-number">03</span>
            <div>
              <h2>근거와 확인 사항</h2>
              <ul className="review-checklist">
                {evidence.length
                  ? evidence.map((item) => (
                      <li key={item.id}>
                        <Check size={13} />
                        <span>
                          <strong>{item.documentName}</strong>{" "}
                          {item.page ? item.page + "쪽 / " : ""}
                          {item.section ?? "문서 본문"}
                          <br />
                          {item.excerpt}
                          <br />
                          <code>{item.contentHash.slice(0, 12)}…</code>
                        </span>
                      </li>
                    ))
                  : evidenceIds.map((evidenceId) => (
                      <li key={evidenceId}>
                        <Check size={13} /> 근거 ID {evidenceId}
                      </li>
                    ))}
                {openItems.map((item) => (
                  <li className="review-open" key={item}>
                    <X size={13} /> {item}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
        <div className="review-provenance">
          <ShieldCheck size={15} />
          <span>
            <strong>산출물 해시 고정 완료</strong>
            {selected.artifactHash.slice(0, 12)}… /{" "}
            {Object.entries(selected.provenance)
              .map(([key, value]) => key + "=" + displayValue(value))
              .join(" / ")}
          </span>
        </div>
        {!decision && selected.status === "PENDING" ? (
          <label className="review-note">
            <span>검토 의견</span>
            <textarea
              aria-label="검토 의견"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="승인 또는 반려의 근거를 기록해 주세요."
              minLength={4}
              maxLength={800}
              rows={3}
              disabled={Boolean(acting) || selected.stale}
            />
            <small>{note.length}/800</small>
          </label>
        ) : null}
        <div className="review-actions">
          <div>
            <span className="reviewer-avatar">{reviewerName.slice(0, 1)}</span>
            <span>
              <strong>{reviewerName} 검토자</strong>
              <small>{message}</small>
            </span>
          </div>
          {!decision && selected.status === "PENDING" ? (
            <>
              <button
                className="button button-danger"
                type="button"
                onClick={() => void decide("REJECTED")}
                disabled={
                  Boolean(acting) || selected.stale || note.trim().length < 4
                }
              >
                {acting === "REJECTED" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <X size={15} />
                )}{" "}
                반려
              </button>
              <button
                className="button button-primary"
                type="button"
                onClick={() => void decide("APPROVED")}
                disabled={
                  Boolean(acting) || selected.stale || note.trim().length < 4
                }
              >
                {acting === "APPROVED" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Check size={15} />
                )}{" "}
                승인
              </button>
            </>
          ) : (
            <span
              className={
                "decision-chip decision-" +
                (decision?.decision ?? selected.status).toLocaleLowerCase()
              }
            >
              <CheckCircle2 size={15} />{" "}
              {(decision?.decision ?? selected.status) === "APPROVED"
                ? "승인 완료"
                : "반려 완료"}
            </span>
          )}
        </div>
        <div className="audit-footer">
          <ShieldCheck size={13} />
          <span>
            승인 전 원문 자료를 다시 확인할 수 있습니다.{" "}
            <Link href={"/documents?matter=" + selected.matterId}>
              케이스 문서 열기
            </Link>
          </span>
        </div>
      </section>
    </div>
  );
}
