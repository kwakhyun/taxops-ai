import { clsx } from "clsx";
import type {
  DocumentStatus,
  EvidenceStatus,
  MatterStatus,
  RiskLevel,
} from "@/lib/domain/types";

const labels: Record<
  MatterStatus | DocumentStatus | EvidenceStatus | RiskLevel,
  string
> = {
  IN_REVIEW: "검토 중",
  READY: "승인 대기",
  NEEDS_INFO: "자료 요청",
  CLOSED: "완료",
  QUARANTINED: "검역 대기",
  SCANNING: "보안 검사",
  PARSING: "인덱싱 중",
  INDEXED: "검색 가능",
  FAILED: "처리 실패",
  PENDING: "근거 승인 대기",
  APPROVED: "AI 근거 승인",
  REJECTED: "AI 근거 제외",
  HIGH: "높음",
  MEDIUM: "보통",
  LOW: "낮음",
};

export function StatusPill({ status }: { status: keyof typeof labels }) {
  const tone =
    status === "HIGH" || status === "FAILED" || status === "REJECTED"
      ? "danger"
      : status === "MEDIUM" || status === "NEEDS_INFO" || status === "PARSING"
        ? "warning"
        : status === "LOW" ||
            status === "READY" ||
            status === "INDEXED" ||
            status === "APPROVED"
          ? "success"
          : status === "CLOSED"
            ? "neutral"
            : "info";

  return (
    <span className={clsx("status-pill", `status-${tone}`)}>
      {labels[status]}
    </span>
  );
}
