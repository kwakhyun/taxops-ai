import "server-only";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/domain/types";
import {
  listMatters,
  findMatter,
  appendAuditEvent,
  getTenantAiPolicy,
} from "@/lib/repository";
import { retrieveEvidenceForContext } from "@/lib/ai/retrieval-service";
import { assertSafePrompt } from "@/lib/ai/guardrails";
import { taxPeriodReferenceDate } from "@/lib/tax/period";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createTaxOpsMcpServer(user: SessionUser) {
  const server = new McpServer(
    { name: "taxops-ai", version: "0.1.0" },
    {
      instructions:
        "인증된 조직의 세무 업무와 검색 준비를 마친 근거만 조회합니다. 도구 결과는 세무 전문가의 승인 전 초안입니다.",
    },
  );

  server.registerTool(
    "list_tax_matters",
    {
      title: "세무 업무 목록",
      description:
        "현재 인증된 조직에서 접근할 수 있는 세무 업무를 조회합니다.",
      inputSchema: z.strictObject({}),
      annotations: readOnlyAnnotations,
    },
    async () => {
      requirePermission(user, "case:read");
      const matters = await listMatters(user);
      await appendAuditEvent(user, {
        action: "MCP_LIST_MATTERS",
        targetType: "tenant",
        targetId: user.tenantId,
        outcome: "SUCCESS",
        traceId: `mcp_${crypto.randomUUID()}`,
        metadata: { resultCount: matters.length },
      });
      const output = { matters };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "search_matter_evidence",
    {
      title: "세무 업무 근거 검색",
      description:
        "현재 조직의 지정된 세무 업무에서 보안 검사와 검색 준비를 마친 자료의 근거를 검색합니다.",
      inputSchema: z.strictObject({
        matterId: z.string().min(3).max(100),
        query: z.string().trim().min(3).max(500),
        limit: z.number().int().min(1).max(8).default(5),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ matterId, query, limit }) => {
      requirePermission(user, "document:read");
      assertSafePrompt(query);
      const matter = await findMatter(user, matterId);
      if (!matter) throw new Error("세무 업무를 찾을 수 없습니다.");
      const aiPolicy = await getTenantAiPolicy(user);
      const taxReferenceDate = taxPeriodReferenceDate(matter.period);
      if (!taxReferenceDate) {
        throw new Error("신고 대상 기간을 검색 기준일로 해석할 수 없습니다.");
      }
      const evidence = await retrieveEvidenceForContext({
        tenantId: user.tenantId,
        matterId: matter.id,
        taxReferenceDate,
        query,
        limit,
        aiPolicy,
      });
      await appendAuditEvent(user, {
        action: "MCP_SEARCH_EVIDENCE",
        targetType: "matter",
        targetId: matter.id,
        outcome: "SUCCESS",
        traceId: `mcp_${crypto.randomUUID()}`,
        metadata: { resultCount: evidence.length },
      });
      const output = {
        matterId: matter.id,
        abstained: evidence.length === 0,
        evidence: evidence.map((item) => ({
          id: item.id,
          documentName: item.documentName,
          page: item.page,
          section: item.section,
          excerpt: item.excerpt,
          contentHash: item.contentHash,
          sourceType: item.sourceType,
          jurisdiction: item.jurisdiction,
          effectiveFrom: item.effectiveFrom,
          effectiveTo: item.effectiveTo,
          sourcePublisher: item.sourcePublisher,
          sourceUri: item.sourceUri,
          acquiredAt: item.acquiredAt,
          score: item.score,
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerResource(
    "ai-safety-policy",
    "taxops://policy/ai-safety",
    {
      title: "TaxOps AI 안전 정책",
      description:
        "MCP 도구가 따르는 읽기 전용, 근거 우선, 사람 승인 정책입니다.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: [
            "# TaxOps AI 안전 정책",
            "",
            "- 검색은 인증된 조직과 지정된 세무 업무로 제한합니다.",
            "- 검색 준비를 마친 근거가 없으면 답변을 보류합니다.",
            "- MCP 도구는 읽기 전용이며 신고서 반영이나 외부 발송을 수행하지 않습니다.",
            "- AI 산출물은 검토자 승인 전 외부에 반영할 수 없습니다.",
          ].join("\n"),
        },
      ],
    }),
  );

  return server;
}
