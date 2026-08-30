import type { AuditEvent } from "@/lib/domain/types";
import { buildCsv } from "@/lib/export/csv";
import { auditActionLabel, auditOutcomeLabel } from "@/lib/ui/labels";

export function formatAuditTime(value: string) {
  return Number.isNaN(Date.parse(value))
    ? value
    : new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

export function auditIpLabel(value: string) {
  return value === "system"
    ? "시스템"
    : value === "not-recorded"
      ? "미기록"
      : value;
}

export function filterAuditEvents(
  events: AuditEvent[],
  query: string,
  outcome: AuditEvent["outcome"] | "ALL",
) {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  return events.filter(
    (event) =>
      (outcome === "ALL" || event.outcome === outcome) &&
      (!normalized ||
        [
          event.actor,
          event.action,
          auditActionLabel(event.action),
          event.target,
          event.traceId,
        ]
          .join(" ")
          .toLocaleLowerCase("ko-KR")
          .includes(normalized)),
  );
}

export function buildAuditCsv(events: AuditEvent[]) {
  return buildCsv([
    [
      "시각",
      "행위자",
      "작업",
      "대상",
      "결과",
      "추적 ID",
      "IP",
      "이전 해시",
      "해시",
    ],
    ...events.map((event) => [
      formatAuditTime(event.occurredAt),
      event.actor,
      auditActionLabel(event.action),
      event.target,
      auditOutcomeLabel(event.outcome),
      event.traceId,
      auditIpLabel(event.ipMasked),
      event.prevHash,
      event.hash,
    ]),
  ]);
}
