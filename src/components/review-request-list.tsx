import { ChevronRight, FileCheck2 } from "lucide-react";
import type { ReviewRequest } from "@/lib/workpapers/artifact";

export function ReviewRequestList({
  requests,
  selectedId,
  onSelect,
}: {
  requests: ReviewRequest[];
  selectedId: string;
  onSelect: (targetId: string) => void;
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
              </small>
            </span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    </section>
  );
}
