import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@/lib/domain/types";
import { buildCsv, csvCell } from "@/lib/export/csv";
import {
  auditIpLabel,
  buildAuditCsv,
  filterAuditEvents,
  formatAuditTime,
} from "@/lib/ui/audit";

const events: AuditEvent[] = [
  {
    id: "audit-1",
    actor: "김실무",
    action: "MATTER_CREATED",
    target: "한빛테크",
    outcome: "SUCCESS",
    occurredAt: "2026-08-30T15:00:00Z",
    traceId: "trace-ABC",
    ipMasked: "system",
    prevHash: "previous",
    hash: "current",
  },
  {
    id: "audit-2",
    actor: "이검토",
    action: "CROSS_TENANT_READ_DENIED",
    target: "다른 조직의 자료",
    outcome: "DENIED",
    occurredAt: "방금 전",
    traceId: "trace-DEF",
    ipMasked: "not-recorded",
    prevHash: "current",
    hash: "next",
  },
];

describe("audit workspace", () => {
  it("searches the visible Korean labels, actor, target and trace ID", () => {
    for (const query of ["업무 등록", "김실무", "한빛", "  TRACE-abc  "]) {
      expect(filterAuditEvents(events, query, "ALL")).toEqual([events[0]]);
    }
  });

  it("combines query and outcome filters without mutating the source", () => {
    expect(filterAuditEvents(events, "", "DENIED")).toEqual([events[1]]);
    expect(filterAuditEvents(events, "김실무", "DENIED")).toEqual([]);
    expect(filterAuditEvents(events, "", "ALL")).toEqual(events);
    expect(events).toHaveLength(2);
  });

  it("uses Korea time and preserves explanatory timestamps and masked IPs", () => {
    expect(formatAuditTime(events[0]!.occurredAt)).toContain("2026. 8. 31.");
    expect(formatAuditTime("방금 전")).toBe("방금 전");
    expect(auditIpLabel("system")).toBe("시스템");
    expect(auditIpLabel("not-recorded")).toBe("미기록");
    expect(auditIpLabel("10.0.*.*")).toBe("10.0.*.*");
  });

  it("exports only selected records with localized outcomes and chain hashes", () => {
    const csv = buildAuditCsv(filterAuditEvents(events, "", "DENIED"));
    expect(csv).toMatch(
      /^\uFEFF시각,행위자,작업,대상,결과,추적 ID,IP,이전 해시,해시\r\n/,
    );
    expect(csv).toContain(
      "이검토,다른 조직 자료 접근 차단,다른 조직의 자료,차단,trace-DEF,미기록,current,next",
    );
    expect(csv).not.toContain("김실무");
  });

  it("quotes CSV punctuation and neutralizes spreadsheet formulas", () => {
    expect(csvCell('업무, "검토"\n완료')).toBe('"업무, ""검토""\n완료"');
    for (const value of [
      "=1+1",
      "+SUM(A1)",
      "-1+1",
      "@SUM(A1)",
      "\t=1+1",
      "  =1+1",
      "  +SUM(A1)",
    ]) {
      expect(csvCell(value)).toBe(`'${value}`);
    }
    expect(csvCell("\n=1+1")).toBe('"\'\n=1+1"');
    expect(csvCell("  일반 메모")).toBe("  일반 메모");
    expect(buildCsv([["한글", 3]])).toBe("\uFEFF한글,3\r\n");
  });
});
