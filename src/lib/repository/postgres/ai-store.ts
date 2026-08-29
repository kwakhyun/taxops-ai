import "server-only";

import { createHash } from "node:crypto";
import type postgres from "postgres";
import { defaultAiBudget } from "@/lib/ai/budget";
import { taxMemoPrompt, taxMemoPromptHash } from "@/lib/ai/prompts/tax-memo.v1";
import { RETRIEVER_VERSION } from "@/lib/ai/retrieval";
import { withTenantSql } from "@/lib/db/client";
import type { SessionUser } from "@/lib/domain/types";
import { appendAuditEventTx } from "@/lib/repository/postgres/audit-store";
import { RepositoryInputError } from "@/lib/repository/postgres/errors";
import {
  mapWorkpaperEvidenceBinding,
  type WorkpaperEvidenceRow,
} from "@/lib/repository/postgres/workpaper-evidence";
import { resolveTenantAiPolicy } from "@/lib/security/ai-policy";
import { hashWorkpaperArtifact } from "@/lib/workpapers/artifact";
export async function getTenantAiPolicy(user: SessionUser) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<
      Array<{
        ai_enabled: boolean;
        pii_policy: Record<string, unknown>;
        data_region: string;
      }>
    >`
      SELECT ai_enabled, pii_policy, data_region
      FROM tenants
      WHERE id = ${user.tenantId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new Error("Tenant AI policy is unavailable");
    return resolveTenantAiPolicy(row.ai_enabled, row.pii_policy, {
      tenantDataRegion: row.data_region,
    });
  });
}

export async function listReviewers(user: SessionUser) {
  return withTenantSql(
    user.tenantId,
    async (transaction) =>
      transaction<
        Array<{ id: string; name: string; role: "REVIEWER" | "ADMIN" }>
      >`
      SELECT member.user_id::text AS id, account.name, member.role
      FROM memberships member
      JOIN users account ON account.id = member.user_id
      WHERE member.tenant_id = ${user.tenantId}
        AND member.role IN ('REVIEWER', 'ADMIN')
        AND member.user_id::text <> ${user.id}
      ORDER BY CASE member.role WHEN 'REVIEWER' THEN 0 ELSE 1 END, account.name
    `,
  );
}

export async function startAgentRun(
  user: SessionUser,
  input: {
    matterId: string;
    traceId: string;
    modelId: string;
    monthlyBudgetKrw: number;
  },
) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const staleRuns = await transaction<
      Array<{ id: string; actor_id: string; trace_id: string }>
    >`
      UPDATE agent_runs
      SET workflow_status = 'FAILED', error_code = 'STALE_STREAM_RECOVERED',
          completed_at = now()
      WHERE tenant_id = ${user.tenantId}
        AND completed_at IS NULL
        AND started_at < now() - interval '2 minutes'
      RETURNING id::text, actor_id::text, trace_id
    `;
    for (const stale of staleRuns) {
      await appendAuditEventTx(
        transaction,
        { tenantId: user.tenantId, id: stale.actor_id },
        {
          action: "AI_RUN_STALE_RECOVERED",
          targetType: "agent_run",
          targetId: stale.id,
          outcome: "FAILED",
          traceId: stale.trace_id,
        },
      );
    }
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-budget:${user.tenantId}`}, 0))`;
    const spendRows = await transaction<Array<{ spent: string }>>`
      SELECT coalesce(sum(estimated_cost_krw), 0)::text AS spent
      FROM agent_runs
      WHERE tenant_id = ${user.tenantId}
        AND started_at >= date_trunc('month', now())
    `;
    const spent = Number(spendRows[0]?.spent ?? 0);
    if (spent + defaultAiBudget.maxEstimatedCostKrw > input.monthlyBudgetKrw) {
      throw Object.assign(
        new Error("조직의 월간 AI 비용 한도에 도달했습니다."),
        { status: 429, code: "TENANT_AI_BUDGET_EXCEEDED" },
      );
    }
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO agent_runs (
        tenant_id, matter_id, actor_id, workflow_status, trace_id, model_id,
        prompt_version, retriever_version, policy_version, estimated_cost_krw
      )
      SELECT ${user.tenantId}, matter.id, ${user.id}, 'INTAKE',
             ${input.traceId}, ${input.modelId}, ${taxMemoPrompt.version},
             ${RETRIEVER_VERSION}, 'tenant-ai-policy.v1',
             ${defaultAiBudget.maxEstimatedCostKrw}
      FROM matters matter
      WHERE matter.tenant_id = ${user.tenantId}
        AND matter.id::text = ${input.matterId}
      RETURNING id::text
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("Agent run could not be created");
    await appendAuditEventTx(transaction, user, {
      action: "AI_RUN_CREATED",
      targetType: "agent_run",
      targetId: id,
      outcome: "SUCCESS",
      traceId: input.traceId,
      metadata: { matterId: input.matterId },
    });
    return id;
  });
}

export async function finishAgentRun(
  user: SessionUser,
  input: {
    runId: string;
    status: "VERIFY" | "AWAITING_REVIEW" | "FAILED";
    inputTokens: number;
    outputTokens: number;
    estimatedCostKrw: number;
    latencyMs: number;
    evidenceCoverage?: number;
    errorCode?: string;
  },
) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<{ trace_id: string }[]>`
      UPDATE agent_runs
      SET workflow_status = ${input.status},
          input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens},
          estimated_cost_krw = ${input.estimatedCostKrw},
          latency_ms = ${input.latencyMs},
          evidence_coverage = ${input.evidenceCoverage ?? null},
          error_code = ${input.errorCode ?? null},
          completed_at = now()
      WHERE tenant_id = ${user.tenantId} AND id::text = ${input.runId}
        AND completed_at IS NULL
      RETURNING trace_id
    `;
    const run = rows[0];
    if (!run) return;
    await appendAuditEventTx(transaction, user, {
      action: input.status === "FAILED" ? "AI_RUN_FAILED" : "AI_RUN_COMPLETED",
      targetType: "agent_run",
      targetId: input.runId,
      outcome: input.status === "FAILED" ? "FAILED" : "SUCCESS",
      traceId: run.trace_id,
      metadata: {
        status: input.status,
        latencyMs: input.latencyMs,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      },
    });
  });
}

export async function assertTenantAiSpendBudget(
  user: SessionUser,
  monthlyBudgetKrw: number,
) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<Array<{ spent: string }>>`
      SELECT coalesce(sum(estimated_cost_krw), 0)::text AS spent
      FROM agent_runs
      WHERE tenant_id = ${user.tenantId}
        AND started_at >= date_trunc('month', now())
    `;
    const spent = Number(rows[0]?.spent ?? 0);
    if (spent >= monthlyBudgetKrw) {
      throw Object.assign(
        new Error("조직의 월간 AI 비용 한도에 도달했습니다."),
        { status: 429, code: "TENANT_AI_BUDGET_EXCEEDED" },
      );
    }
    return { spentKrw: spent, monthlyBudgetKrw };
  });
}

export async function recordRetrievalEvent(input: {
  tenantId: string;
  runId: string;
  query: string;
  evidenceIds: string[];
  scores: number[];
  latencyMs: number;
}) {
  return withTenantSql(input.tenantId, async (transaction) => {
    await transaction`
      INSERT INTO retrieval_events (
        tenant_id, run_id, query_hash, chunk_ids, scores, filter_summary,
        latency_ms
      ) VALUES (
        ${input.tenantId}, ${input.runId},
        ${createHash("sha256").update(input.query).digest("hex")},
        ${input.evidenceIds}::uuid[], ${transaction.json(input.scores)},
        ${transaction.json({ scope: "tenant+matter", currentOnly: "true" })},
        ${input.latencyMs}
      )
    `;
  });
}

export async function recordToolCall(input: {
  tenantId: string;
  runId: string;
  name: string;
  toolInput: unknown;
  toolOutput?: unknown;
  status: "SUCCEEDED" | "FAILED";
  latencyMs: number;
}) {
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return withTenantSql(input.tenantId, async (transaction) => {
    await transaction`
      INSERT INTO tool_calls (
        tenant_id, run_id, tool_name, tool_version, input_hash, output_hash,
        status, latency_ms
      ) VALUES (
        ${input.tenantId}, ${input.runId}, ${input.name}, '1.0',
        ${digest(input.toolInput)},
        ${input.toolOutput === undefined ? null : digest(input.toolOutput)},
        ${input.status}, ${input.latencyMs}
      )
    `;
  });
}

export async function createWorkpaperDraft(input: {
  tenantId: string;
  matterId: string;
  actorId: string;
  runId: string;
  traceId: string;
  taxReferenceDate: string;
  title: string;
  conclusion: string;
  evidenceIds: string[];
  evidenceHashes: Record<string, string | undefined>;
  calculations: Array<Record<string, string | number>>;
  abortSignal?: AbortSignal;
}) {
  return withTenantSql(input.tenantId, async (transaction) => {
    input.abortSignal?.throwIfAborted();
    if (
      input.evidenceIds.length === 0 ||
      new Set(input.evidenceIds).size !== input.evidenceIds.length
    ) {
      throw new RepositoryInputError(
        "검토조서에는 중복되지 않은 검증 근거가 1개 이상 필요합니다.",
      );
    }
    const scopeRows = await transaction<Array<{ reviewer_id: string }>>`
      SELECT matter.reviewer_id::text
      FROM matters matter
      JOIN agent_runs run
        ON run.tenant_id = matter.tenant_id
       AND run.matter_id = matter.id
      WHERE matter.tenant_id = ${input.tenantId}
        AND matter.id::text = ${input.matterId}
        AND matter.reviewer_id::text <> ${input.actorId}
        AND run.id::text = ${input.runId}
        AND run.actor_id::text = ${input.actorId}
        AND run.trace_id = ${input.traceId}
        AND run.workflow_status IN ('INTAKE', 'VERIFY')
        AND run.completed_at IS NULL
    `;
    const scope = scopeRows[0];
    const evidenceRows = await transaction<WorkpaperEvidenceRow[]>`
      SELECT chunk.id::text, document.original_name AS document_name,
             chunk.page_number, chunk.section, chunk.content AS excerpt,
             chunk.content_hash, chunk.source_type, chunk.jurisdiction,
             chunk.effective_from, chunk.effective_to,
             document.source_publisher, document.source_uri,
             document.acquired_at
      FROM document_chunks chunk
      JOIN documents document
        ON document.tenant_id = chunk.tenant_id
       AND document.id = chunk.document_id
       AND document.matter_id = chunk.matter_id
       AND document.version = chunk.document_version
      WHERE chunk.tenant_id = ${input.tenantId}
        AND chunk.matter_id::text = ${input.matterId}
        AND chunk.id = ANY(${input.evidenceIds}::uuid[])
        AND chunk.is_current = true
        AND document.status = 'INDEXED'
        AND document.evidence_status = 'APPROVED'
        AND document.injection_scan_status = 'SAFE'
    `;
    input.abortSignal?.throwIfAborted();
    if (
      !scope ||
      evidenceRows.length !== new Set(input.evidenceIds).size ||
      evidenceRows.some(
        (item) => input.evidenceHashes[item.id] !== item.content_hash,
      )
    ) {
      throw new RepositoryInputError(
        "작성자와 검토자가 분리된 현재 세무 업무의 유효한 근거만 연결할 수 있습니다.",
      );
    }
    const targetId = crypto.randomUUID();
    const content = {
      conclusion: input.conclusion,
      evidenceIds: [...new Set(input.evidenceIds)],
      evidence: evidenceRows.map(mapWorkpaperEvidenceBinding),
      calculations: input.calculations,
      openItems: ["검토자의 세무 판단과 계산 입력값 확인"],
    };
    const provenance = {
      runId: input.runId,
      traceId: input.traceId,
      promptVersion: taxMemoPrompt.version,
      promptHash: taxMemoPromptHash,
      retrieverVersion: RETRIEVER_VERSION,
      taxReferenceDate: input.taxReferenceDate,
    };
    const artifactHash = hashWorkpaperArtifact({
      targetId,
      matterId: input.matterId,
      title: input.title,
      version: 1,
      content,
      provenance,
    });
    input.abortSignal?.throwIfAborted();
    const created = await transaction<Array<{ target_id: string }>>`
      SELECT request.target_id::text
      FROM create_workpaper_review_request(
        ${input.tenantId}::uuid, ${input.matterId}::uuid,
        ${input.actorId}::uuid, ${input.runId}::uuid, ${input.traceId},
        ${input.title},
        ${transaction.json(content as unknown as postgres.JSONValue)},
        ${transaction.json(provenance)}, ${artifactHash}, ${targetId}::uuid
      ) request
    `;
    if (created[0]?.target_id !== targetId) {
      throw new RepositoryInputError(
        "완료되었거나 취소된 AI 분석에서는 검토 요청을 만들 수 없습니다.",
      );
    }
    input.abortSignal?.throwIfAborted();
    return { targetId, artifactHash, version: 1 };
  });
}
