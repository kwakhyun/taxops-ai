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
        "인증된 워크스페이스의 세무 케이스와 인덱싱된 근거만 읽습니다. 도구 결과는 세무 전문가 승인 전 초안입니다.",
    },
  );

  server.registerTool(
    "list_tax_matters",
    {
      title: "세무 케이스 목록",
      description:
        "현재 인증된 테넌트에서 접근 가능한 세무 케이스를 조회합니다.",
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
      title: "케이스 근거 검색",
      description:
        "현재 테넌트의 지정된 케이스 안에서 검역과 인덱싱을 통과한 문서 근거를 검색합니다.",
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
      if (!matter) throw new Error("케이스를 찾을 수 없습니다.");
      const aiPolicy = await getTenantAiPolicy(user);
      const taxReferenceDate = taxPeriodReferenceDate(matter.period);
      if (!taxReferenceDate) {
        throw new Error("케이스 과세기간을 검색 기준일로 해석할 수 없습니다.");
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
            "- 검색은 인증된 테넌트와 지정 케이스로 제한합니다.",
            "- 인덱싱을 통과한 근거가 없으면 답변을 보류합니다.",
            "- MCP 도구는 읽기 전용이며 신고서 반영이나 외부 발송을 수행하지 않습니다.",
            "- AI 산출물은 Reviewer 승인 전 외부에 반영할 수 없습니다.",
          ].join("\n"),
        },
      ],
    }),
  );

  return server;
}
