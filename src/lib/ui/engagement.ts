import type { Matter } from "@/lib/domain/types";

export const engagementSections = [
  {
    key: "overview",
    label: "업무 개요",
    shortLabel: "개요",
    description: "범위와 담당자 설정",
  },
  {
    key: "documents",
    label: "자료 수집",
    shortLabel: "자료",
    description: "자료 요청과 보안 검사",
  },
  {
    key: "research",
    label: "근거 검토",
    shortLabel: "근거",
    description: "법령과 업무 자료 검색",
  },
  {
    key: "calculation",
    label: "계산 및 초안",
    shortLabel: "초안",
    description: "계산과 검토조서 초안",
  },
  {
    key: "review",
    label: "검토 및 승인",
    shortLabel: "검토",
    description: "독립 검토와 승인",
  },
  {
    key: "filing",
    label: "신고 및 사후 관리",
    shortLabel: "신고",
    description: "신고 전 점검과 사후 관리",
  },
] as const;

export type EngagementSectionKey = (typeof engagementSections)[number]["key"];

export function getEngagementStageIndex(matter: Matter) {
  if (matter.status === "CLOSED") return engagementSections.length - 1;
  if (matter.status === "IN_REVIEW") return 4;
  if (matter.status === "NEEDS_INFO") return 1;
  if (matter.progress >= 90) return 5;
  if (matter.progress >= 70) return 4;
  if (matter.progress >= 50) return 3;
  if (matter.progress >= 30) return 2;
  if (matter.progress >= 10) return 1;
  return 0;
}

export function getEngagementSectionHref(
  key: EngagementSectionKey,
  matterId: string,
  canReview = false,
) {
  const encodedMatterId = encodeURIComponent(matterId);
  switch (key) {
    case "overview":
      return `/cases/${encodedMatterId}`;
    case "documents":
      return `/documents?matter=${encodedMatterId}`;
    case "research":
      return `/assistant?matter=${encodedMatterId}`;
    case "calculation":
      return `/assistant?matter=${encodedMatterId}#analysis-workspace`;
    case "review":
      return canReview
        ? `/reviews?matter=${encodedMatterId}`
        : `/cases/${encodedMatterId}#review-status`;
    case "filing":
      return `/cases/${encodedMatterId}#filing`;
  }
}

export function getEngagementNextAction(matter: Matter) {
  if (matter.status === "CLOSED") return "사후 관리 기록 확인";
  if (matter.status === "NEEDS_INFO") return "미수취 자료 요청";
  if (matter.status === "IN_REVIEW") return "검토 의견 반영";
  if (matter.progress >= 90) return "신고 전 최종 점검";
  if (matter.progress >= 50) return "계산 결과와 초안 확인";
  return "근거 자료 보완";
}
