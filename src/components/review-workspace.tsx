"use client";

import { FileCheck2 } from "lucide-react";
import { ReviewDocument } from "@/components/review-document";
import { ReviewRequestList } from "@/components/review-request-list";
import { useReviewWorkspace } from "@/components/use-review-workspace";
import type { ReviewRequest } from "@/lib/workpapers/artifact";

export function ReviewWorkspace({
  requests,
  reviewerName,
}: {
  requests: ReviewRequest[];
  reviewerName: string;
}) {
  const workspace = useReviewWorkspace(requests);

  if (!workspace.selected) {
    return (
      <section className="card empty-state">
        <FileCheck2 size={24} />
        <h2>배정된 검토 요청이 없습니다.</h2>
        <p>검증을 통과한 검토조서 초안이 제출되면 이곳에 표시됩니다.</p>
      </section>
    );
  }

  return (
    <div className="review-layout">
      <ReviewRequestList
        requests={requests}
        selectedId={workspace.selected.targetId}
        onSelect={workspace.selectRequest}
      />
      <ReviewDocument
        selected={workspace.selected}
        reviewerName={reviewerName}
        decision={workspace.decision}
        acting={workspace.acting}
        note={workspace.note}
        message={workspace.message}
        onNoteChange={workspace.setNote}
        onDecide={(decision) => void workspace.decide(decision)}
      />
    </div>
  );
}
