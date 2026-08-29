import type { ReviewRequest } from "@/lib/workpapers/artifact";

export type ReviewDecision = {
  decision: "APPROVED" | "REJECTED";
  reviewer: string;
  note: string;
};

export type EvidenceSnapshot = {
  id: string;
  documentName: string;
  page?: number | null;
  section?: string | null;
  excerpt: string;
  contentHash: string;
};

export function textList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function displayValue(value: unknown) {
  if (typeof value === "number") return value.toLocaleString("ko-KR");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

const calculationLabels: Record<string, string> = {
  ledgerAmount: "원장상 부가가치세액",
  returnAmount: "신고서 반영액",
  difference: "차이 금액",
  taxableTotal: "공급가액 합계",
  rate: "세율",
  vat: "부가가치세액",
  formula: "계산식",
};

const provenanceLabels: Record<string, string> = {
  runId: "실행 ID",
  traceId: "추적 ID",
  promptVersion: "프롬프트 버전",
  promptHash: "프롬프트 해시",
  retrieverVersion: "검색 파이프라인 버전",
  taxReferenceDate: "세법 적용 기준일",
};

export function calculationLabel(value: string) {
  return calculationLabels[value] ?? value;
}

export function calculationValue(label: string, value: unknown) {
  if (label === "rate" && typeof value === "number") {
    return `${value * 100}%`;
  }
  if (
    [
      "ledgerAmount",
      "returnAmount",
      "difference",
      "taxableTotal",
      "vat",
    ].includes(label) &&
    typeof value === "number"
  ) {
    return `${value.toLocaleString("ko-KR")}원`;
  }
  if (label === "formula" && typeof value === "string") {
    const match = value.match(/^(\d+(?:\.\d+)?) × (0?\.\d+)$/);
    if (match) {
      return `${Number(match[1]).toLocaleString("ko-KR")} × ${Number(match[2]) * 100}%`;
    }
  }
  return displayValue(value);
}

export function provenanceLabel(value: string) {
  return provenanceLabels[value] ?? value;
}

export function provenanceValue(label: string, value: unknown) {
  if (label === "taxReferenceDate" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
    }
  }
  return displayValue(value);
}

export function evidenceSnapshots(value: unknown): EvidenceSnapshot[] {
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

export function reviewDocumentModel(selected: ReviewRequest) {
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
  return {
    conclusion,
    calculations,
    evidence,
    evidenceIds,
    openItems: textList(selected.content.openItems),
  };
}
