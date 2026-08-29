import { describe, expect, it } from "vitest";
import type { Matter } from "@/lib/domain/types";
import { buildMattersCsv } from "@/lib/export/matters-csv";
import { attachmentContentDisposition } from "@/lib/files/download";
import { healthDetailsAuthorized } from "@/lib/health/readiness";

const matter: Matter = {
  id: "matter-1",
  client: '한빛,테크 "본사"',
  taxType: "부가가치세",
  period: "2026년 제1기",
  owner: "곽현",
  reviewer: "이서윤",
  status: "IN_REVIEW",
  risk: "HIGH",
  progress: 60,
  dueDate: "2026. 07. 27",
  openFindings: 2,
  evidenceCoverage: 80,
  updatedAt: "방금 전",
  summary: "신고서와 원장 대사",
};

describe("업무 지원 기능", () => {
  it("엑셀 호환 BOM과 CSV escaping을 적용해 업무 목록을 내보낸다", () => {
    const csv = buildMattersCsv([matter]);
    expect(csv.startsWith("\uFEFF고객사,세목")).toBe(true);
    expect(csv).toContain('"한빛,테크 ""본사"""');
    expect(csv).toContain("60%,80%");
    expect(csv).toContain("검토 중,높음");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(buildMattersCsv([{ ...matter, client: "=1+1" }])).toContain("'=1+1");
  });

  it("한글 파일명과 안전한 ASCII 대체 이름을 함께 제공한다", () => {
    expect(attachmentContentDisposition('신고서 "초안".pdf')).toBe(
      "attachment; filename=\"___ ____.pdf\"; filename*=UTF-8''%EC%8B%A0%EA%B3%A0%EC%84%9C%20%22%EC%B4%88%EC%95%88%22.pdf",
    );
  });
});

describe("readiness 상세 진단 인증", () => {
  const token = "readiness-detail-token-at-least-32-characters";

  it("일치하는 bearer token만 허용한다", () => {
    expect(healthDetailsAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(healthDetailsAuthorized("Bearer invalid", token)).toBe(false);
    expect(healthDetailsAuthorized(null, token)).toBe(false);
  });

  it("길이가 짧은 운영 token은 구성 오류로 보고 거부한다", () => {
    expect(healthDetailsAuthorized("Bearer short", "short")).toBe(false);
  });
});
