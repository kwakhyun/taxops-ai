import {
  Check,
  CheckCircle2,
  LoaderCircle,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  calculationLabel,
  calculationValue,
  provenanceLabel,
  provenanceValue,
  reviewDocumentModel,
  type ReviewDecision,
} from "@/components/review-workspace-model";
import type { ReviewRequest } from "@/lib/workpapers/artifact";

export function ReviewDocument({
  selected,
  reviewerName,
  decision,
  acting,
  note,
  message,
  onNoteChange,
  onDecide,
}: {
  selected: ReviewRequest;
  reviewerName: string;
  decision?: ReviewDecision;
  acting?: "APPROVED" | "REJECTED";
  note: string;
  message: string;
  onNoteChange: (value: string) => void;
  onDecide: (decision: "APPROVED" | "REJECTED") => void;
}) {
  const { conclusion, calculations, evidence, evidenceIds, openItems } =
    reviewDocumentModel(selected);
  const effectiveDecision = decision?.decision ?? selected.status;

  return (
    <section className="review-document card">
      <div className="review-document-header">
        <div>
          <span className="card-kicker">검토조서 버전 {selected.version}</span>
          <h1>{selected.title}</h1>
          <p>
            {selected.client} · {selected.period} {selected.taxType}
          </p>
        </div>
        <span
          className={
            "status-pill " +
            (selected.stale || effectiveDecision === "REJECTED"
              ? "status-danger"
              : effectiveDecision === "APPROVED"
                ? "status-success"
                : "status-warning")
          }
        >
          {selected.stale
            ? "새 버전 확인 필요"
            : effectiveDecision === "APPROVED"
              ? "승인 완료"
              : effectiveDecision === "REJECTED"
                ? "반려 완료"
                : "검토 대기"}
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
                    <div
                      key={calculationIndex + "-" + label}
                      className={
                        label === "formula" ? "calculation-formula" : undefined
                      }
                    >
                      <span>{calculationLabel(label)}</span>
                      <strong>{calculationValue(label, value)}</strong>
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
                        {item.page ? item.page + "쪽 · " : ""}
                        {item.section ?? "문서 본문"}
                        <br />
                        {item.excerpt}
                        <br />
                        <code>내용 해시 {item.contentHash.slice(0, 12)}…</code>
                      </span>
                    </li>
                  ))
                : evidenceIds.map((evidenceId) => (
                    <li key={evidenceId}>
                      <Check size={13} /> 근거 번호 {evidenceId}
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
          <strong>검토 대상 버전이 고정되었습니다.</strong>
          {selected.artifactHash.slice(0, 12)}… ·{" "}
          {Object.entries(selected.provenance)
            .map(
              ([key, value]) =>
                provenanceLabel(key) + ": " + provenanceValue(key, value),
            )
            .join(" · ")}
        </span>
      </div>
      {!decision && selected.status === "PENDING" ? (
        <label className="review-note">
          <span>검토 의견</span>
          <textarea
            aria-label="검토 의견"
            aria-describedby="review-note-hint"
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="승인 또는 반려의 근거를 기록해 주세요."
            minLength={4}
            maxLength={800}
            rows={3}
            disabled={Boolean(acting) || selected.stale}
          />
          <small>{note.length}/800</small>
          <small id="review-note-hint" className="review-note-hint">
            승인 또는 반려하려면 검토 의견을 4자 이상 입력해 주세요.
          </small>
        </label>
      ) : null}
      <div className="review-actions">
        <div>
          <span className="reviewer-avatar">{reviewerName.slice(0, 1)}</span>
          <span>
            <strong>{reviewerName} · 검토자</strong>
            <small role="status">{message}</small>
          </span>
        </div>
        {!decision && selected.status === "PENDING" ? (
          <>
            <button
              className="button button-danger"
              type="button"
              onClick={() => onDecide("REJECTED")}
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
              onClick={() => onDecide("APPROVED")}
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
              "decision-chip decision-" + effectiveDecision.toLocaleLowerCase()
            }
          >
            <CheckCircle2 size={15} />{" "}
            {effectiveDecision === "APPROVED" ? "승인 완료" : "반려 완료"}
          </span>
        )}
      </div>
      <div className="audit-footer">
        <ShieldCheck size={13} />
        <span>
          승인하기 전에 원문 자료를 다시 확인할 수 있습니다.{" "}
          <Link href={"/documents?matter=" + selected.matterId}>
            업무 자료 보기
          </Link>
        </span>
      </div>
    </section>
  );
}
