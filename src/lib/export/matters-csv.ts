import type { Matter } from "@/lib/domain/types";
import { statusLabel } from "@/lib/ui/labels";
import { buildCsv } from "@/lib/export/csv";

const headers = [
  "고객사",
  "세목",
  "대상 기간",
  "담당자",
  "검토자",
  "진행 상태",
  "리스크",
  "진행률",
  "근거 사용 승인율",
  "마감일",
  "미해결 검토사항",
  "업무 요약",
] as const;

export function buildMattersCsv(matters: Matter[]) {
  const rows = matters.map((matter) => [
    matter.client,
    matter.taxType,
    matter.period,
    matter.owner,
    matter.reviewer,
    statusLabel(matter.status),
    statusLabel(matter.risk),
    `${matter.progress}%`,
    `${matter.evidenceCoverage}%`,
    matter.dueDate,
    matter.openFindings ?? "미평가",
    matter.summary,
  ]);
  return buildCsv([headers, ...rows]);
}
