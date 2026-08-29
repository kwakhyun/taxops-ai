import type { Matter } from "@/lib/domain/types";
import { statusLabel } from "@/lib/ui/labels";

const headers = [
  "고객사",
  "세목",
  "대상 기간",
  "담당자",
  "검토자",
  "진행 상태",
  "리스크",
  "진행률",
  "근거 충족률",
  "마감일",
  "미해결 검토사항",
  "업무 요약",
] as const;

function csvCell(value: string | number) {
  const raw = String(value);
  const text = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

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
    matter.openFindings,
    matter.summary,
  ]);
  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}
