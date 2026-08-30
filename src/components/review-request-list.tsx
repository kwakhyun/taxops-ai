import { ChevronRight, FileCheck2 } from "lucide-react";
import type { ReviewRequest } from "@/lib/workpapers/artifact";

export function ReviewRequestList({
  requests,
  selectedId,
  onSelect,
  disabled = false,
}: {
  requests: ReviewRequest[];
  selectedId: string;
  onSelect: (targetId: string) => void;
  disabled?: boolean;
}) {
  return (
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
              (request.targetId === selectedId ? "review-list-item-active" : "")
            }
            key={request.targetId}
            type="button"
            disabled={disabled}
            aria-pressed={request.targetId === selectedId}
            onClick={() => onSelect(request.targetId)}
          >
            <span className="review-list-icon">
              <FileCheck2 size={17} />
            </span>
            <span>
              <strong>
                {request.client} · {request.title}
              </strong>
              <small>
                검토조서 버전 {request.version} · 요청자 {request.requestedBy}
                {request.status === "APPROVED"
                  ? " · 승인 완료"
                  : request.status === "REJECTED"
                    ? " · 반려 완료"
                    : ""}
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    </section>
  );
}
