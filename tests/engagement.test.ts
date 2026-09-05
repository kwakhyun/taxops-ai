import { describe, expect, it } from "vitest";
import type { Matter, MatterStatus } from "@/lib/domain/types";
import {
  engagementSections,
  getEngagementNextAction,
  getEngagementSectionHref,
  getEngagementStageIndex,
} from "@/lib/ui/engagement";

function matter(status: MatterStatus = "READY", progress = 0): Matter {
  return {
    id: "vat-2025-q4",
    client: "한빛테크 주식회사",
    taxType: "부가가치세",
    period: "2025년 제2기 확정신고",
    owner: "박민호",
    reviewer: "김서윤",
    status,
    risk: "HIGH",
    progress,
    dueDate: "2026-01-26",
    openFindings: 3,
    evidenceCoverage: 92,
    updatedAt: "2026-08-30T09:00:00+09:00",
    summary: "매입세액 불공제 사전 검토",
  };
}

describe("engagement UI model", () => {
  it("maps domain status and progress to the six-stage workflow", () => {
    const cases: Array<[MatterStatus, number, number]> = [
      ["READY", 0, 0],
      ["READY", 10, 1],
      ["READY", 30, 2],
      ["READY", 50, 3],
      ["READY", 70, 4],
      ["READY", 90, 5],
      ["NEEDS_INFO", 80, 1],
      ["IN_REVIEW", 20, 4],
      ["CLOSED", 20, 5],
    ];

    for (const [status, progress, expected] of cases) {
      expect(getEngagementStageIndex(matter(status, progress))).toBe(expected);
    }
  });

  it("links every engagement stage to an existing TaxOps route", () => {
    expect(
      engagementSections.map((section) =>
        getEngagementSectionHref(section.key, "vat 2025/q4"),
      ),
    ).toEqual([
      "/cases/vat%202025%2Fq4",
      "/documents?matter=vat%202025%2Fq4",
      "/assistant?matter=vat%202025%2Fq4",
      "/assistant?matter=vat%202025%2Fq4#analysis-workspace",
      "/cases/vat%202025%2Fq4#review-status",
      "/cases/vat%202025%2Fq4#filing",
    ]);
  });

  it("derives an actionable next step from the current workflow state", () => {
    expect(getEngagementNextAction(matter("NEEDS_INFO", 60))).toBe(
      "미수취 자료 요청",
    );
    expect(getEngagementNextAction(matter("IN_REVIEW", 80))).toBe(
      "검토 의견 반영",
    );
    expect(getEngagementNextAction(matter("CLOSED", 100))).toBe(
      "사후 관리 기록 확인",
    );
    expect(getEngagementNextAction(matter("READY", 95))).toBe(
      "신고 전 최종 점검",
    );
    expect(getEngagementNextAction(matter("READY", 60))).toBe(
      "계산 결과와 초안 확인",
    );
    expect(getEngagementNextAction(matter("READY", 20))).toBe("근거 자료 보완");
  });
});
