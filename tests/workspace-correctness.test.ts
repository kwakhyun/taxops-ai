import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { filingChecks } from "@/lib/ui/filing";
import { dashboardWorklists, deadlineLabel } from "@/lib/ui/dashboard";
import { streamedAssistantEvidence } from "@/components/assistant-message-model";
import { verifiedToolOutputOnlyTransform } from "@/lib/ai/stream-policy";
import { getEngagementSectionHref } from "@/lib/ui/engagement";
import {
  auditQuerySchema,
  auditDateBounds,
  matterQuerySchema,
  escapeLike,
} from "@/lib/contracts/listing";
import { demoUsers, matters, documents } from "@/lib/domain/fixtures";
import {
  queryAuditEvents,
  queryMatters,
  searchMatters,
  appendAuditEvent,
  resetDemoStoreForTests,
  listDocuments,
} from "@/lib/repository/demo-store";
import type { MatterAnalysis } from "@/lib/domain/types";
import type { TaxAssistantMessage } from "@/lib/ai/types";

const analysis: MatterAnalysis = {
  latestRun: {
    id: "run-1",
    matterId: "matter-1",
    status: "COMPLETED",
    question: "질문",
    startedAt: "",
    latencyMs: 10,
    tokens: 10,
    estimatedCostKrw: 1,
    retrievalHits: 1,
    evidenceCoverage: 100,
    promptVersion: "test",
    model: "test",
    traceId: "trace-1",
  },
  workflowSteps: [
    { key: "VERIFY", label: "검증", description: "", status: "COMPLETE" },
  ],
  workpaper: {
    title: "조서",
    conclusion: "결론",
    reviewStatus: "APPROVED",
    evidence: [],
  },
};

describe("workspace state correctness", () => {
  it("requires indexed and approved documents, not just an uploaded file", () => {
    const document = {
      ...documents[0]!,
      status: "INDEXED" as const,
      evidenceStatus: "APPROVED" as const,
    };
    expect(filingChecks([], analysis)[0]?.complete).toBe(false);
    expect(
      filingChecks([{ ...document, status: "FAILED" }], analysis)[0]?.complete,
    ).toBe(false);
    expect(
      filingChecks([{ ...document, evidenceStatus: "PENDING" }], analysis)[0]
        ?.complete,
    ).toBe(false);
    expect(
      filingChecks([document], analysis).every((item) => item.complete),
    ).toBe(true);
  });
  it("never marks failed, running or incomplete verification as filing ready", () => {
    for (const status of ["FAILED", "RUNNING"] as const) {
      const checks = filingChecks([], {
        ...analysis,
        latestRun: { ...analysis.latestRun, status },
      });
      expect(checks[1]?.complete).toBe(false);
      expect(checks[2]?.complete).toBe(false);
    }
    expect(
      filingChecks([], {
        ...analysis,
        latestRun: { ...analysis.latestRun, evidenceCoverage: 0 },
      })[1]?.complete,
    ).toBe(false);
    expect(
      filingChecks([], { ...analysis, workflowSteps: [] })[1]?.complete,
    ).toBe(false);
    expect(
      filingChecks([], { ...analysis, workpaper: undefined })[2]?.complete,
    ).toBe(false);
    expect(
      filingChecks([], {
        ...analysis,
        workpaper: { ...analysis.workpaper!, reviewStatus: "REJECTED" },
      })[2]?.helper,
    ).toContain("반려");
  });
  it("orders deadlines independently from risk and excludes closed matters", () => {
    const list = dashboardWorklists([
      {
        ...matters[0]!,
        id: "urgent",
        risk: "LOW",
        dueDate: "2026. 09. 05",
        status: "READY",
      },
      { ...matters[0]!, id: "risk", risk: "HIGH", dueDate: "2026. 09. 12" },
      {
        ...matters[0]!,
        id: "closed",
        risk: "HIGH",
        dueDate: "2026. 01. 01",
        status: "CLOSED",
      },
    ]);
    expect(list.priority.map((item) => item.id)).toEqual(["risk", "urgent"]);
    expect(list.schedule.map((item) => item.id)).toEqual(["urgent", "risk"]);
    expect(deadlineLabel("2026. 09. 04", "2026-09-05")).toBe("마감 지남");
    expect(deadlineLabel("2026. 09. 05", "2026-09-05")).toBe("오늘 마감");
  });
  it("keeps review navigation inside the current matter and role", () => {
    expect(getEngagementSectionHref("review", "abc", false)).toBe(
      "/cases/abc#review-status",
    );
    expect(getEngagementSectionHref("review", "abc", true)).toBe(
      "/reviews?matter=abc",
    );
  });
  it("preserves source location across the real stream projection without inventing a score", async () => {
    const parts = [
      {
        type: "tool-call",
        toolName: "deliverVerifiedAnswer",
        toolCallId: "t1",
        input: {},
      },
      {
        type: "tool-result",
        toolName: "deliverVerifiedAnswer",
        toolCallId: "t1",
        output: {
          verified: true,
          requiresHumanReview: true,
          conclusion: "결론",
          evidence: [
            {
              id: "e1",
              documentName: "자료.pdf",
              excerpt: "원문",
              page: 12,
              section: "거래 내역",
              contentHash: "hash",
            },
          ],
        },
      },
    ];
    const stream = new ReadableStream({
      start(controller) {
        parts.forEach((part) => controller.enqueue(part));
        controller.close();
      },
    }).pipeThrough(verifiedToolOutputOnlyTransform({}));
    const reader = stream.getReader();
    let output: unknown;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === "tool-result") output = next.value.output;
    }
    const result = streamedAssistantEvidence({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-deliverVerifiedAnswer",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output,
        },
      ],
    } as TaxAssistantMessage);
    expect(result[0]?.location).toBe("12쪽 · 거래 내역");
    expect(result[0]?.score).toBeUndefined();
  });
});

describe("server list contracts", () => {
  beforeEach(() => vi.stubEnv("E2E_RESET_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("searches past the old 200-record boundary and scopes pages to the tenant", () => {
    resetDemoStoreForTests();
    const user = demoUsers.admin!;
    for (let i = 0; i < 205; i++)
      appendAuditEvent(user, {
        action: "TEST_EVENT",
        targetType: "matter",
        targetId: `target-${i}`,
        outcome: "SUCCESS",
        traceId: `searchable-${i}`,
      });
    const result = queryAuditEvents(
      user,
      auditQuerySchema.parse({ q: "searchable-0" }),
    );
    expect(result.total).toBe(1);
    expect(result.items[0]?.traceId).toBe("searchable-0");
    const first = queryAuditEvents(
      user,
      auditQuerySchema.parse({ pageSize: 10 }),
    );
    const second = queryAuditEvents(
      user,
      auditQuerySchema.parse({ pageSize: 10, page: 2 }),
    );
    expect(first.items).toHaveLength(10);
    expect(second.items).toHaveLength(10);
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(20);
    expect(
      queryAuditEvents(
        { ...user, tenantId: "other" },
        auditQuerySchema.parse({}),
      ).total,
    ).toBe(0);
    resetDemoStoreForTests();
  });
  it("applies date boundaries in Korea and rejects invalid/reversed dates", () => {
    expect(auditQuerySchema.safeParse({ from: "2026-02-30" }).success).toBe(
      false,
    );
    expect(
      auditQuerySchema.safeParse({ from: "2026-09-06", to: "2026-09-05" })
        .success,
    ).toBe(false);
    const bounds = auditDateBounds({ from: "2026-09-05", to: "2026-09-05" });
    expect(bounds.from?.toISOString()).toBe("2026-09-04T15:00:00.000Z");
    expect(bounds.to?.toISOString()).toBe("2026-09-05T15:00:00.000Z");
    expect(escapeLike("a%_\\b")).toBe("a\\%\\_\\\\b");
  });
  it("paginates filtered matters and derives the document approval metric", () => {
    resetDemoStoreForTests();
    const user = demoUsers.analyst!;
    const result = queryMatters(
      user,
      matterQuerySchema.parse({ q: "리브온", pageSize: 1 }),
    );
    const search = searchMatters(
      user,
      matterQuerySchema.parse({ q: "리브온", pageSize: 9 }),
    );
    expect(Object.keys(search.items[0]!).sort()).toEqual([
      "client",
      "id",
      "period",
      "summary",
      "taxType",
    ]);
    expect(result.total).toBe(1);
    expect(result.items[0]?.client).toBe("리브온 커머스");
    const first = queryMatters(user, matterQuerySchema.parse({ pageSize: 1 }))
      .items[0]!;
    const docs = listDocuments(user, first.id);
    expect(first.evidenceCoverage).toBe(
      Math.round(
        (100 *
          docs.filter(
            (doc) =>
              doc.status === "INDEXED" && doc.evidenceStatus === "APPROVED",
          ).length) /
          docs.length,
      ),
    );
  });
});
