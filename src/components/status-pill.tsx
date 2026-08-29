import { clsx } from "clsx";
import type {
  DocumentStatus,
  EvidenceStatus,
  MatterStatus,
  RiskLevel,
} from "@/lib/domain/types";
import { statusLabel } from "@/lib/ui/labels";

type Status = MatterStatus | DocumentStatus | EvidenceStatus | RiskLevel;

export function StatusPill({ status }: { status: Status }) {
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
      {statusLabel(status)}
    </span>
  );
}
