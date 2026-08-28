import "server-only";

import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { CreateMatterInput } from "@/lib/contracts/cases";
import type {
  AuditEvent,
  DocumentRecord,
  Evidence,
  EvidenceReviewPreview,
  Matter,
  MatterAnalysis,
  SessionUser,
} from "@/lib/domain/types";
import { withReviewerTenantSql, withTenantSql } from "@/lib/db/client";
import type { DemoJob } from "@/lib/repository/demo-store";
import {
  hashWorkpaperArtifact,
  workpaperEvidenceBindingMatches,
  workpaperEvidenceBindings,
  type ReviewRequest,
  type WorkpaperEvidenceBinding,
} from "@/lib/workpapers/artifact";
import { resolveTenantAiPolicy } from "@/lib/security/ai-policy";
import { taxMemoPrompt, taxMemoPromptHash } from "@/lib/ai/prompts/tax-memo.v1";
import { RETRIEVER_VERSION } from "@/lib/ai/retrieval";
import { defaultAiBudget } from "@/lib/ai/budget";
import { evidenceManifestHash } from "@/lib/documents/evidence-manifest";
import { detectPromptInjection } from "@/lib/ai/guardrails";
import { normalizeTrustedSourceUri } from "@/lib/security/source-provenance";
import {
  decideEvidenceViaReviewService,
  decideWorkpaperViaReviewService,
  reviewServiceIsConfigured,
} from "@/lib/review/service-client";

interface MatterRow {
  id: string;
  client: string;
  tax_type: string;
  tax_period: string;
  owner: string;
  reviewer: string;
  status: Matter["status"];
  risk: Matter["risk"];
  due_at: Date;
  updated_at: Date;
  summary: string;
  document_count: number;
  indexed_count: number;
}

interface DocumentRow {
  id: string;
  matter_id: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  status: DocumentRecord["status"];
  evidence_status: DocumentRecord["evidenceStatus"];
  pii_classification: DocumentRecord["piiClass"];
  uploader_name: string;
  updated_at: Date;
  checksum_sha256: string;
  source_type: DocumentRecord["sourceType"];
  source_publisher?: string | null;
  source_uri?: string | null;
  acquired_at?: Date | null;
  evidence_manifest_sha256?: string | null;
  uploaded_by?: string;
  evidence_reviewable?: boolean;
  version?: number;
  chunk_count?: number;
  page_count?: number;
}

interface JobRow {
  id: string;
  tenant_id: string;
  type: DemoJob["type"];
  status: DemoJob["status"];
  progress: number;
  idempotency_key: string;
  payload: { documentId?: string };
  created_at: Date;
}

interface WorkpaperEvidenceRow {
  id: string;
  document_name: string;
  page_number: number | null;
  section: string | null;
  excerpt: string;
  content_hash: string;
  source_type: WorkpaperEvidenceBinding["sourceType"];
  jurisdiction: string;
  effective_from: Date | null;
  effective_to: Date | null;
  source_publisher: string | null;
  source_uri: string | null;
  acquired_at: Date | null;
}

function mapWorkpaperEvidenceBinding(
  row: WorkpaperEvidenceRow,
): WorkpaperEvidenceBinding {
  return {
    id: row.id,
    documentName: row.document_name,
    page: row.page_number,
    section: row.section,
    excerpt: row.excerpt,
    contentHash: row.content_hash,
    sourceType: row.source_type,
    jurisdiction: row.jurisdiction,
    effectiveFrom: row.effective_from?.toISOString() ?? null,
    effectiveTo: row.effective_to?.toISOString() ?? null,
    sourcePublisher: row.source_publisher,
    sourceUri: row.source_uri,
    acquiredAt: row.acquired_at?.toISOString() ?? null,
  };
}

export class RepositoryInputError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code = "INVALID_INPUT",
  ) {
    super(message);
    this.name = "RepositoryInputError";
  }
}

interface AuditWriteInput {
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditEvent["outcome"];
  traceId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

async function appendAuditEventTx(
  transaction: postgres.TransactionSql,
  user: Pick<SessionUser, "tenantId" | "id">,
  input: AuditWriteInput,
) {
  const rows = await transaction<{ id: string }[]>`
    SELECT append_application_audit_event(
      ${user.tenantId}::uuid, ${user.id}::uuid, ${input.action},
      ${input.targetType}, ${input.targetId}::uuid, ${input.outcome},
      ${input.traceId}, ${transaction.json(input.metadata ?? {})}
    )::text AS id
  `;
  return rows[0]?.id;
}

function displayDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return valueFor("year") + ". " + valueFor("month") + ". " + valueFor("day");
}

function progressFor(status: Matter["status"]) {
  return { IN_REVIEW: 70, READY: 92, NEEDS_INFO: 48, CLOSED: 100 }[status];
}

function mapMatter(row: MatterRow): Matter {
  const total = Number(row.document_count);
  const indexed = Number(row.indexed_count);
  return {
    id: row.id,
    client: row.client,
    taxType: row.tax_type,
    period: row.tax_period,
    owner: row.owner,
    reviewer: row.reviewer,
    status: row.status,
    risk: row.risk,
    progress: progressFor(row.status),
    dueDate: displayDate(row.due_at),
    openFindings: 0,
    evidenceCoverage: total ? Math.round((indexed / total) * 100) : 0,
    updatedAt: displayDate(row.updated_at),
    summary: row.summary,
  };
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    matterId: row.matter_id,
    name: row.original_name,
    kind:
      row.mime_type.includes("spreadsheet") || row.mime_type === "text/csv"
        ? "원장"
        : "증빙",
    size: `${(Number(row.byte_size) / 1024 / 1024).toFixed(2)} MB`,
    status: row.status,
    evidenceStatus: row.evidence_status,
    pages: Number(row.page_count ?? 0),
    chunks: Number(row.chunk_count ?? 0),
    piiClass: row.pii_classification,
    uploadedBy: row.uploader_name,
    updatedAt: displayDate(row.updated_at),
    checksum: `sha256:${row.checksum_sha256.slice(0, 8)}…${row.checksum_sha256.slice(-4)}`,
    sourceType: row.source_type,
    evidenceReviewable: row.evidence_reviewable ?? false,
  };
}

function mapJob(row: JobRow): DemoJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    idempotencyKey: row.idempotency_key,
    resourceId: row.payload.documentId ?? "",
    createdAt: row.created_at.toISOString(),
  };
}

const matterSelect = `
  SELECT m.id::text, c.name AS client, m.tax_type, m.tax_period,
         owner.name AS owner, reviewer.name AS reviewer, m.status, m.risk,
         m.due_at, m.updated_at, m.summary,
         count(d.id)::int AS document_count,
         count(d.id) FILTER (WHERE d.status = 'INDEXED')::int AS indexed_count
  FROM matters m
  JOIN clients c ON c.tenant_id = m.tenant_id AND c.id = m.client_id
  JOIN users owner ON owner.id = m.owner_id
  JOIN users reviewer ON reviewer.id = m.reviewer_id
  LEFT JOIN documents d ON d.tenant_id = m.tenant_id AND d.matter_id = m.id
`;

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
        new Error("워크스페이스의 월간 AI 비용 한도에 도달했습니다."),
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
        new Error("워크스페이스의 월간 AI 비용 한도에 도달했습니다."),
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
        "워크페이퍼에는 중복되지 않은 검증 근거가 1개 이상 필요합니다.",
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
        "작성자와 Reviewer가 분리된 현재 케이스의 유효한 근거만 연결할 수 있습니다.",
      );
    }
    const targetId = crypto.randomUUID();
    const content = {
      conclusion: input.conclusion,
      evidenceIds: [...new Set(input.evidenceIds)],
      evidence: evidenceRows.map(mapWorkpaperEvidenceBinding),
      calculations: input.calculations,
      openItems: ["Reviewer의 세무 판단과 계산 입력 확인"],
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
        "완료되었거나 취소된 AI 실행에서는 검토 요청을 만들 수 없습니다.",
      );
    }
    input.abortSignal?.throwIfAborted();
    return { targetId, artifactHash, version: 1 };
  });
}

export async function listMatters(user: SessionUser) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<MatterRow[]>(
      `${matterSelect}
      WHERE m.tenant_id = $1
      GROUP BY m.id, c.name, owner.name, reviewer.name
      ORDER BY m.updated_at DESC`,
      [user.tenantId],
    );
    return rows.map(mapMatter);
  });
}

export async function findMatter(user: SessionUser, id: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<MatterRow[]>(
      `${matterSelect}
      WHERE m.tenant_id = $1 AND (m.id::text = $2 OR m.slug = $2)
      GROUP BY m.id, c.name, owner.name, reviewer.name
      LIMIT 1`,
      [user.tenantId, id],
    );
    return rows[0] ? mapMatter(rows[0]) : undefined;
  });
}

type AnalysisWorkflowStatus =
  | "INTAKE"
  | "RETRIEVE"
  | "DRAFT"
  | "VERIFY"
  | "AWAITING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "FAILED";

interface MatterAnalysisRow {
  id: string;
  matter_id: string;
  workflow_status: AnalysisWorkflowStatus;
  trace_id: string;
  model_id: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_krw: string;
  latency_ms: number | null;
  evidence_coverage: string | null;
  started_at: Date;
  retrieval_hits: number;
  workpaper_title: string | null;
  workpaper_content: Record<string, unknown> | null;
  review_status: "PENDING" | "APPROVED" | "REJECTED" | null;
}

function persistedWorkflowSteps(
  status: AnalysisWorkflowStatus,
): MatterAnalysis["workflowSteps"] {
  const definitions = [
    ["INTAKE", "요청 분류", "민감정보 정책과 세목 범위 확인"],
    ["RETRIEVE", "근거 검색", "현재 케이스의 승인된 근거 검색"],
    ["DRAFT", "분석 초안", "결정론적 계산과 세무 분석 초안 생성"],
    ["VERIFY", "독립 검증", "주장, 계산, 출처 바인딩 검증"],
    ["AWAITING_REVIEW", "전문가 검토", "Reviewer 결정 전 외부 반영 차단"],
  ] as const;
  const activeIndex = Math.max(
    0,
    definitions.findIndex(([key]) => key === status),
  );
  return definitions.map(([key, label, description], index) => {
    let stepStatus: MatterAnalysis["workflowSteps"][number]["status"];
    if (status === "APPROVED") stepStatus = "COMPLETE";
    else if (status === "REJECTED")
      stepStatus = index < definitions.length - 1 ? "COMPLETE" : "BLOCKED";
    else if (status === "FAILED")
      stepStatus = index === 0 ? "BLOCKED" : "WAITING";
    else if (index < activeIndex) stepStatus = "COMPLETE";
    else if (index === activeIndex) stepStatus = "ACTIVE";
    else stepStatus = "WAITING";
    return { key, label, description, status: stepStatus };
  });
}

function storedDifference(content: Record<string, unknown>) {
  const candidates = [
    content.calculation,
    ...(Array.isArray(content.calculations) ? content.calculations : []),
  ];
  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const difference = (candidate as Record<string, unknown>).difference;
    if (typeof difference === "number" && Number.isFinite(difference)) {
      return difference;
    }
  }
  return undefined;
}

export async function getMatterAnalysis(
  user: SessionUser,
  matterId: string,
): Promise<MatterAnalysis | undefined> {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<MatterAnalysisRow[]>`
      SELECT run.id::text, run.matter_id::text, run.workflow_status,
             run.trace_id, run.model_id, run.prompt_version,
             run.input_tokens, run.output_tokens,
             run.estimated_cost_krw::text, run.latency_ms,
             run.evidence_coverage::text, run.started_at,
             COALESCE(retrieval.hits, 0)::int AS retrieval_hits,
             artifact.title AS workpaper_title,
             artifact.content AS workpaper_content,
             artifact.review_status
      FROM agent_runs run
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(cardinality(event.chunk_ids)), 0)::int AS hits
        FROM retrieval_events event
        WHERE event.tenant_id = run.tenant_id AND event.run_id = run.id
      ) retrieval ON true
      LEFT JOIN LATERAL (
        SELECT workpaper.title, version.content,
               approval.status::text AS review_status
        FROM workpapers workpaper
        JOIN workpaper_versions version
          ON version.tenant_id = workpaper.tenant_id
         AND version.workpaper_id = workpaper.id
         AND version.version = workpaper.current_version
        LEFT JOIN approvals approval
          ON approval.tenant_id = workpaper.tenant_id
         AND approval.target_id = workpaper.id
         AND approval.target_type = 'workpaper'
         AND approval.target_version = workpaper.current_version
        WHERE workpaper.tenant_id = run.tenant_id
          AND workpaper.matter_id = run.matter_id
        ORDER BY version.created_at DESC, workpaper.id DESC
        LIMIT 1
      ) artifact ON true
      WHERE run.tenant_id = ${user.tenantId}
        AND run.matter_id::text = ${matterId}
      ORDER BY run.started_at DESC, run.id DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    const runStatus =
      row.workflow_status === "FAILED"
        ? "FAILED"
        : row.workflow_status === "AWAITING_REVIEW" ||
            row.workflow_status === "REJECTED"
          ? "NEEDS_REVIEW"
          : row.workflow_status === "APPROVED" ||
              (row.workflow_status === "VERIFY" && row.latency_ms !== null)
            ? "COMPLETED"
            : "RUNNING";
    const content = row.workpaper_content;
    const bindings = content ? workpaperEvidenceBindings(content) : undefined;
    return {
      latestRun: {
        id: row.id,
        matterId: row.matter_id,
        status: runStatus,
        question: "저장된 케이스 세무 분석 실행",
        startedAt: row.started_at.toLocaleString("ko-KR", {
          timeZone: "Asia/Seoul",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        latencyMs: row.latency_ms ?? 0,
        tokens: Number(row.input_tokens) + Number(row.output_tokens),
        estimatedCostKrw: Number(row.estimated_cost_krw),
        retrievalHits: Number(row.retrieval_hits),
        evidenceCoverage: Number(row.evidence_coverage ?? 0),
        promptVersion: row.prompt_version,
        model: row.model_id,
        traceId: row.trace_id,
      },
      workflowSteps: persistedWorkflowSteps(row.workflow_status),
      workpaper:
        content && row.workpaper_title && row.review_status
          ? {
              title: row.workpaper_title,
              conclusion:
                typeof content.conclusion === "string"
                  ? content.conclusion
                  : "저장된 결론이 없습니다.",
              amountKrw: storedDifference(content),
              reviewStatus: row.review_status,
              evidence: (bindings ?? []).map((binding) => ({
                id: binding.id,
                documentName: binding.documentName,
                page: binding.page,
                section: binding.section,
                excerpt: binding.excerpt,
                contentHash: binding.contentHash,
              })),
            }
          : undefined,
    };
  });
}

export async function listDocuments(user: SessionUser, matterId?: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<DocumentRow[]>(
      `SELECT d.id::text, d.matter_id::text, d.original_name, d.mime_type,
              d.byte_size, d.status, d.evidence_status, d.pii_classification,
              d.source_type,
              uploader.name AS uploader_name,
              d.updated_at, d.checksum_sha256,
              (matter.reviewer_id::text = $3 AND d.uploaded_by::text <> $3)
                AS evidence_reviewable,
              count(chunk.id)::int AS chunk_count,
              coalesce(max(chunk.page_number), 0)::int AS page_count
       FROM documents d
       JOIN matters matter
         ON matter.tenant_id = d.tenant_id AND matter.id = d.matter_id
       JOIN users uploader ON uploader.id = d.uploaded_by
       LEFT JOIN document_chunks chunk
         ON chunk.tenant_id = d.tenant_id
        AND chunk.document_id = d.id
        AND chunk.matter_id = d.matter_id
        AND chunk.document_version = d.version
        AND chunk.is_current = true
       WHERE d.tenant_id = $1 AND ($2::text IS NULL OR d.matter_id::text = $2)
       GROUP BY d.id, uploader.name, matter.reviewer_id
       ORDER BY d.updated_at DESC`,
      [user.tenantId, matterId ?? null, user.id],
    );
    return rows.map(mapDocument);
  });
}

export async function getDocumentEvidenceReview(
  user: SessionUser,
  documentId: string,
): Promise<EvidenceReviewPreview | undefined> {
  return withTenantSql(user.tenantId, async (transaction) => {
    const documents = await transaction<
      Array<
        DocumentRow & {
          version: number;
          chunk_count: number;
        }
      >
    >`
      SELECT document.id::text, document.matter_id::text,
             document.original_name, document.mime_type, document.byte_size,
             document.status, document.evidence_status,
             document.pii_classification, uploader.name AS uploader_name,
             document.updated_at, document.checksum_sha256, document.source_type,
             document.source_publisher, document.source_uri,
             document.acquired_at, document.evidence_manifest_sha256,
             document.version,
             count(chunk.id)::int AS chunk_count
      FROM documents document
      JOIN matters matter
        ON matter.tenant_id = document.tenant_id
       AND matter.id = document.matter_id
      JOIN users uploader ON uploader.id = document.uploaded_by
      LEFT JOIN document_chunks chunk
        ON chunk.tenant_id = document.tenant_id
       AND chunk.document_id = document.id
       AND chunk.document_version = document.version
       AND chunk.is_current = true
      WHERE document.tenant_id = ${user.tenantId}
        AND document.id::text = ${documentId}
        AND document.status = 'INDEXED'
        AND document.evidence_status = 'PENDING'
        AND document.injection_scan_status = 'SAFE'
        AND matter.reviewer_id::text = ${user.id}
        AND document.uploaded_by::text <> ${user.id}
      GROUP BY document.id, uploader.name
    `;
    const document = documents[0];
    if (!document) return undefined;
    const chunks = await transaction<
      Array<{
        id: string;
        chunk_index: number;
        page_number: number | null;
        section: string | null;
        excerpt: string;
        content_hash: string;
        source_type: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
        jurisdiction: string;
        effective_from: Date | null;
        effective_to: Date | null;
      }>
    >`
      SELECT chunk.id::text, chunk.chunk_index, chunk.page_number,
             chunk.section, chunk.content AS excerpt, chunk.content_hash,
             chunk.source_type, chunk.jurisdiction, chunk.effective_from,
             chunk.effective_to
      FROM document_chunks chunk
      WHERE chunk.tenant_id = ${user.tenantId}
        AND chunk.document_id::text = ${documentId}
        AND chunk.document_version = ${document.version}
        AND chunk.is_current = true
      ORDER BY chunk.chunk_index
    `;
    if (chunks.length === 0) return undefined;
    const manifestSha256 = evidenceManifestHash({
      documentId: document.id,
      version: document.version,
      sourceChecksumSha256: document.checksum_sha256,
      sourcePublisher: document.source_publisher,
      sourceUri: document.source_uri,
      acquiredAt: document.acquired_at?.toISOString() ?? null,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunk_index,
        contentHash: chunk.content_hash,
        sourceType: chunk.source_type,
        jurisdiction: chunk.jurisdiction,
        effectiveFrom: chunk.effective_from?.toISOString() ?? null,
        effectiveTo: chunk.effective_to?.toISOString() ?? null,
      })),
    });
    if (document.evidence_manifest_sha256 !== manifestSha256) return undefined;
    return {
      documentId: document.id,
      matterId: document.matter_id,
      name: document.original_name,
      version: document.version,
      uploadedBy: document.uploader_name,
      checksumSha256: document.checksum_sha256,
      manifestSha256,
      chunkCount: Number(document.chunk_count),
      sourcePublisher: document.source_publisher ?? null,
      sourceUri: document.source_uri ?? null,
      acquiredAt: document.acquired_at?.toISOString() ?? null,
      previewChunks: chunks.map((chunk) => ({
        id: chunk.id,
        page: chunk.page_number,
        section: chunk.section,
        excerpt: chunk.excerpt,
        contentHash: chunk.content_hash,
        sourceType: chunk.source_type,
        jurisdiction: chunk.jurisdiction,
        effectiveFrom: chunk.effective_from?.toISOString() ?? null,
        effectiveTo: chunk.effective_to?.toISOString() ?? null,
      })),
    };
  });
}

export async function setDocumentEvidenceDecision(
  user: SessionUser,
  documentId: string,
  decision: "APPROVED" | "REJECTED",
  expectedChecksumSha256: string,
  expectedManifestSha256: string,
  traceId?: string,
) {
  if (reviewServiceIsConfigured()) {
    const result = await decideEvidenceViaReviewService(user, documentId, {
      decision,
      checksumSha256: expectedChecksumSha256,
      manifestSha256: expectedManifestSha256,
      traceId: traceId ?? `tr_${crypto.randomUUID()}`,
    });
    if (!result) return undefined;
    return (await listDocuments(user)).find(
      (document) => document.id === result.documentId,
    );
  }
  return withReviewerTenantSql(user.tenantId, async (transaction) => {
    const scopes = await transaction<
      Array<
        DocumentRow & {
          version: number;
        }
      >
    >`
      SELECT document.id::text, document.matter_id::text,
             document.original_name, document.mime_type, document.byte_size,
             document.status, document.evidence_status,
             document.pii_classification, uploader.name AS uploader_name,
             document.updated_at, document.checksum_sha256, document.source_type,
             document.source_publisher, document.source_uri,
             document.acquired_at, document.evidence_manifest_sha256,
             document.version
      FROM documents document
      JOIN matters matter
        ON matter.tenant_id = document.tenant_id
       AND matter.id = document.matter_id
      JOIN users uploader ON uploader.id = document.uploaded_by
      WHERE document.tenant_id = ${user.tenantId}
        AND document.id::text = ${documentId}
        AND document.status = 'INDEXED'
        AND document.evidence_status = 'PENDING'
        AND document.injection_scan_status = 'SAFE'
        AND matter.reviewer_id::text = ${user.id}
        AND document.uploaded_by::text <> ${user.id}
        AND document.checksum_sha256 = ${expectedChecksumSha256}
    `;
    const scope = scopes[0];
    if (!scope) return undefined;
    const manifestRows = await transaction<
      Array<{
        id: string;
        chunk_index: number;
        content_hash: string;
        source_type: string;
        jurisdiction: string;
        effective_from: Date | null;
        effective_to: Date | null;
      }>
    >`
      SELECT id::text, chunk_index, content_hash, source_type, jurisdiction,
             effective_from, effective_to
      FROM document_chunks
      WHERE tenant_id = ${user.tenantId}
        AND document_id::text = ${documentId}
        AND document_version = ${scope.version}
        AND is_current = true
      ORDER BY chunk_index
    `;
    if (
      manifestRows.length === 0 ||
      evidenceManifestHash({
        documentId: scope.id,
        version: scope.version,
        sourceChecksumSha256: scope.checksum_sha256,
        sourcePublisher: scope.source_publisher,
        sourceUri: scope.source_uri,
        acquiredAt: scope.acquired_at?.toISOString() ?? null,
        chunks: manifestRows.map((chunk) => ({
          id: chunk.id,
          chunkIndex: chunk.chunk_index,
          contentHash: chunk.content_hash,
          sourceType: chunk.source_type,
          jurisdiction: chunk.jurisdiction,
          effectiveFrom: chunk.effective_from?.toISOString() ?? null,
          effectiveTo: chunk.effective_to?.toISOString() ?? null,
        })),
      }) !== expectedManifestSha256 ||
      scope.evidence_manifest_sha256 !== expectedManifestSha256
    ) {
      return undefined;
    }
    const decisions = await transaction<{ id: string }[]>`
      SELECT document_id::text AS id
      FROM decide_document_evidence(
        ${user.tenantId}::uuid, ${documentId}::uuid, ${user.id}::uuid,
        ${decision}, ${expectedChecksumSha256}, ${scope.version},
        ${expectedManifestSha256}, ${traceId ?? `tr_${crypto.randomUUID()}`}
      )
    `;
    if (!decisions[0]) return undefined;
    const rows = await transaction<DocumentRow[]>`
      SELECT document.id::text, document.matter_id::text,
             document.original_name, document.mime_type, document.byte_size,
             document.status, document.evidence_status,
             document.pii_classification, uploader.name AS uploader_name,
             document.updated_at, document.checksum_sha256,
             document.source_type
      FROM documents document
      JOIN users uploader ON uploader.id = document.uploaded_by
      WHERE document.tenant_id = ${user.tenantId}
        AND document.id::text = ${documentId}
    `;
    const document = rows[0] ? mapDocument(rows[0]) : undefined;
    return document;
  });
}

function parseDueDate(value: string) {
  const match = /^(\d{4})\. (\d{2})\. (\d{2})$/.exec(value);
  if (!match)
    throw new RepositoryInputError("마감일 형식이 올바르지 않습니다.");
  const canonical = match[1] + ". " + match[2] + ". " + match[3];
  const dueAt = new Date(
    match[1] + "-" + match[2] + "-" + match[3] + "T00:00:00+09:00",
  );
  if (Number.isNaN(dueAt.getTime()) || displayDate(dueAt) !== canonical) {
    throw new RepositoryInputError("존재하지 않는 마감일입니다.");
  }
  return dueAt;
}

export async function createMatter(
  user: SessionUser,
  input: CreateMatterInput,
  traceId?: string,
) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const clientRows = await transaction<{ id: string }[]>`
      INSERT INTO clients (tenant_id, name)
      VALUES (${user.tenantId}, ${input.client})
      ON CONFLICT (tenant_id, name) DO UPDATE SET updated_at = now()
      RETURNING id::text
    `;
    const reviewerRows = await transaction<{ id: string; name: string }[]>`
      SELECT u.id::text, u.name
      FROM users u
      JOIN memberships membership ON membership.user_id = u.id
      WHERE membership.tenant_id = ${user.tenantId}
        AND membership.role IN ('REVIEWER', 'ADMIN')
        AND u.id::text <> ${user.id}
        AND u.id::text = ${input.reviewerId}
    `;
    const client = clientRows[0];
    const reviewer = reviewerRows[0];
    if (!client || !reviewer) {
      throw new RepositoryInputError(
        "현재 워크스페이스에서 Reviewer를 찾을 수 없습니다.",
      );
    }

    const slug = `matter-${crypto.randomUUID().slice(0, 12)}`;
    const dueAt = parseDueDate(input.dueDate);
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO matters (
        tenant_id, client_id, slug, tax_type, tax_period, summary,
        owner_id, reviewer_id, due_at
      ) VALUES (
        ${user.tenantId}, ${client.id}, ${slug}, ${input.taxType}, ${input.period},
        ${input.summary}, ${user.id}, ${reviewer.id}, ${dueAt}
      ) RETURNING id::text
    `;
    const createdId = rows[0]?.id;
    if (!createdId) throw new Error("Matter insert did not return an id");
    if (traceId) {
      await appendAuditEventTx(transaction, user, {
        action: "MATTER_CREATED",
        targetType: "matter",
        targetId: createdId,
        outcome: "SUCCESS",
        traceId,
      });
    }
    return {
      id: createdId,
      client: input.client,
      taxType: input.taxType,
      period: input.period,
      owner: user.name,
      reviewer: reviewer.name,
      status: "IN_REVIEW",
      risk: "LOW",
      progress: 8,
      dueDate: input.dueDate,
      openFindings: 0,
      evidenceCoverage: 0,
      updatedAt: "방금 전",
      summary: input.summary,
    } satisfies Matter;
  });
}

export async function enqueueDocument(
  user: SessionUser,
  input: {
    matterId: string;
    name: string;
    mimeType: string;
    size: number;
    checksum: string;
    objectKey?: string;
    objectVersionId?: string;
    objectEtag?: string;
    objectChecksumSha256?: string;
    idempotencyKey: string;
    sourceType: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
    sourcePublisher?: string;
    sourceUri?: string;
    acquiredAt?: string;
    traceId?: string;
  },
) {
  let normalizedSourceUri: string | undefined;
  try {
    normalizedSourceUri = input.sourceUri
      ? normalizeTrustedSourceUri(input.sourceUri)
      : undefined;
  } catch {
    throw new RepositoryInputError(
      "출처 주소는 허용된 HTTPS 도메인을 사용해야 합니다.",
      "SOURCE_URI_NOT_ALLOWED",
    );
  }
  if (
    input.sourcePublisher &&
    detectPromptInjection(input.sourcePublisher.normalize("NFKC"))
  ) {
    throw new RepositoryInputError(
      "발행기관에 안전하지 않은 지시 패턴이 포함되어 있습니다.",
      "SOURCE_PROVENANCE_UNSAFE",
    );
  }
  if (
    input.sourceType === "TAX_AUTHORITY" &&
    (!input.sourcePublisher || !normalizedSourceUri || !input.acquiredAt)
  ) {
    throw new RepositoryInputError(
      "공식 세무 자료에는 발행기관, 원문 주소, 취득시각이 필요합니다.",
      "SOURCE_PROVENANCE_REQUIRED",
    );
  }
  const hasObjectBinding =
    input.objectVersionId !== undefined ||
    input.objectEtag !== undefined ||
    input.objectChecksumSha256 !== undefined;
  if (
    hasObjectBinding &&
    (!input.objectVersionId ||
      !input.objectEtag ||
      input.objectChecksumSha256 !== input.checksum)
  ) {
    throw new RepositoryInputError(
      "업로드 객체의 버전, ETag, 체크섬 바인딩이 완전하지 않습니다.",
      "OBJECT_BINDING_INVALID",
    );
  }
  if (
    process.env.NODE_ENV === "production" &&
    (!input.objectKey?.startsWith("s3://") || !hasObjectBinding)
  ) {
    throw new RepositoryInputError(
      "운영 업로드에는 변경 불가능한 S3 객체 버전 바인딩이 필요합니다.",
      "OBJECT_BINDING_REQUIRED",
    );
  }
  return withTenantSql(user.tenantId, async (transaction) => {
    async function finalize<
      T extends {
        document: DocumentRecord;
        job: DemoJob;
        deduplicated: boolean;
      },
    >(result: T) {
      if (input.traceId) {
        await appendAuditEventTx(transaction, user, {
          action: result.deduplicated
            ? "DOCUMENT_UPLOAD_DEDUPLICATED"
            : "DOCUMENT_QUEUED",
          targetType: "document",
          targetId: result.document.id,
          outcome: "SUCCESS",
          traceId: input.traceId,
          metadata: { jobId: result.job.id },
        });
      }
      return result;
    }
    const existingByChecksum = async () => {
      const documentRows = await transaction<DocumentRow[]>`
        SELECT d.id::text, d.matter_id::text, d.original_name, d.mime_type,
               d.byte_size, d.status, d.evidence_status, d.pii_classification,
               uploader.name AS uploader_name, d.updated_at, d.checksum_sha256,
               d.source_type, d.source_publisher, d.source_uri, d.acquired_at,
               d.uploaded_by::text
        FROM documents d
        JOIN users uploader ON uploader.id = d.uploaded_by
        WHERE d.tenant_id = ${user.tenantId}
          AND d.matter_id::text = ${input.matterId}
          AND d.checksum_sha256 = ${input.checksum}
        LIMIT 1
      `;
      const document = documentRows[0];
      if (!document) return undefined;
      if (document.uploaded_by !== user.id) {
        throw new RepositoryInputError(
          "다른 작성자가 업로드한 동일 파일은 자동 중복 처리하지 않습니다.",
          "CROSS_ACTOR_DEDUPLICATION_DENIED",
        );
      }
      if (document.source_type !== input.sourceType) {
        throw new RepositoryInputError(
          "동일 파일은 기존 출처 분류와 다르게 재사용할 수 없습니다. 별도 재분류 검토가 필요합니다.",
          "SOURCE_CLASSIFICATION_CONFLICT",
        );
      }
      if (
        document.source_publisher !== (input.sourcePublisher ?? null) ||
        document.source_uri !== (normalizedSourceUri ?? null)
      ) {
        throw new RepositoryInputError(
          "동일 파일의 공식 출처 provenance가 기존 기록과 다릅니다.",
          "SOURCE_PROVENANCE_CONFLICT",
        );
      }
      const jobRows = await transaction<JobRow[]>`
        SELECT id::text, tenant_id::text, type, status, progress,
               idempotency_key, payload, created_at
        FROM jobs
        WHERE tenant_id = ${user.tenantId}
          AND payload->>'documentId' = ${document.id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const job = jobRows[0];
      return job
        ? {
            document: mapDocument(document),
            job: mapJob(job),
            deduplicated: true as const,
          }
        : undefined;
    };

    const existingJobs = await transaction<JobRow[]>`
      SELECT id::text, tenant_id::text, type, status, progress, idempotency_key,
             payload, created_at
      FROM jobs
      WHERE tenant_id = ${user.tenantId} AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    const existingJob = existingJobs[0];
    if (existingJob?.payload.documentId) {
      const documentRows = await transaction<DocumentRow[]>`
        SELECT d.id::text, d.matter_id::text, d.original_name, d.mime_type,
               d.byte_size, d.status, d.evidence_status, d.pii_classification,
               u.name AS uploader_name,
               d.updated_at, d.checksum_sha256, d.source_type,
               d.source_publisher, d.source_uri, d.acquired_at,
               d.uploaded_by::text
        FROM documents d JOIN users u ON u.id = d.uploaded_by
        WHERE d.tenant_id = ${user.tenantId} AND d.id::text = ${existingJob.payload.documentId}
        LIMIT 1
      `;
      if (documentRows[0]) {
        const document = documentRows[0];
        if (
          document.matter_id !== input.matterId ||
          document.checksum_sha256 !== input.checksum ||
          document.original_name !== input.name ||
          document.mime_type !== input.mimeType ||
          Number(document.byte_size) !== input.size ||
          document.source_type !== input.sourceType ||
          document.uploaded_by !== user.id ||
          document.source_publisher !== (input.sourcePublisher ?? null) ||
          document.source_uri !== (normalizedSourceUri ?? null)
        ) {
          throw new RepositoryInputError(
            "같은 Idempotency-Key를 다른 업로드에 재사용할 수 없습니다.",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        return finalize({
          document: mapDocument(document),
          job: mapJob(existingJob),
          deduplicated: true,
        });
      }
    }

    const checksumMatch = await existingByChecksum();
    if (checksumMatch) return finalize(checksumMatch);

    const documentRows = await transaction<DocumentRow[]>`
      INSERT INTO documents (
        tenant_id, matter_id, object_key, object_version_id, object_etag,
        object_checksum_sha256, original_name, normalized_name,
        mime_type, byte_size, checksum_sha256, pii_classification, source_type,
        source_publisher, source_uri, acquired_at, uploaded_by
      ) VALUES (
        ${user.tenantId}, ${input.matterId}, ${input.objectKey ?? "quarantine://missing"},
        ${input.objectVersionId ?? null}, ${input.objectEtag ?? null},
        ${input.objectChecksumSha256 ?? null},
        ${input.name}, ${input.name}, ${input.mimeType}, ${input.size}, ${input.checksum},
        'RESTRICTED', ${input.sourceType}, ${input.sourcePublisher ?? null},
        ${normalizedSourceUri ?? null}, ${input.acquiredAt ?? null}, ${user.id}
      )
      ON CONFLICT (tenant_id, matter_id, checksum_sha256) DO NOTHING
      RETURNING id::text, matter_id::text, original_name, mime_type, byte_size,
                status, evidence_status, pii_classification,
                ${user.name}::text AS uploader_name,
                updated_at, checksum_sha256, source_type, source_publisher,
                source_uri, acquired_at
    `;
    const document = documentRows[0];
    if (!document) {
      const racedMatch = await existingByChecksum();
      if (racedMatch) return finalize(racedMatch);
      throw new Error("Document insert did not return an id");
    }
    const jobRows = await transaction<JobRow[]>`
      INSERT INTO jobs (tenant_id, type, idempotency_key, payload)
      VALUES (
        ${user.tenantId}, 'DOCUMENT_INGESTION', ${input.idempotencyKey},
        ${transaction.json({ documentId: document.id })}
      )
      RETURNING id::text, tenant_id::text, type, status, progress,
                idempotency_key, payload, created_at
    `;
    const job = jobRows[0];
    if (!job) throw new Error("Job insert did not return an id");
    return finalize({
      document: mapDocument(document),
      job: mapJob(job),
      deduplicated: false,
    });
  });
}

export async function getJob(user: SessionUser, id: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<JobRow[]>`
      SELECT id::text, tenant_id::text, type, status, progress, idempotency_key,
             payload, created_at
      FROM jobs
      WHERE tenant_id = ${user.tenantId} AND id::text = ${id}
      LIMIT 1
    `;
    return rows[0] ? mapJob(rows[0]) : undefined;
  });
}

export async function listAuditEvents(user: SessionUser) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<
      Array<{
        id: string;
        tenant_id: string;
        occurred_at: Date;
        actor_id: string;
        action: string;
        target_type: string;
        target_id: string;
        outcome: AuditEvent["outcome"];
        trace_id: string;
        metadata: Record<string, string | number | boolean | null>;
        previous_hash: string;
        hash: string;
      }>
    >`
      SELECT id::text, tenant_id::text, occurred_at, actor_id, action,
             target_type, target_id, outcome, trace_id, metadata,
             previous_hash, hash
      FROM audit_events
      WHERE tenant_id = ${user.tenantId}
      ORDER BY occurred_at DESC
      LIMIT 200
    `;
    return rows.map(
      (row) =>
        ({
          id: row.id,
          tenantId: row.tenant_id,
          actorId: row.actor_id,
          targetType: row.target_type,
          metadata: row.metadata,
          occurredAt: row.occurred_at.toISOString(),
          actor: row.actor_id,
          action: row.action,
          target: row.target_id,
          outcome: row.outcome,
          traceId: row.trace_id,
          ipMasked: "not-recorded",
          prevHash: row.previous_hash,
          hash: row.hash,
        }) satisfies AuditEvent,
    );
  });
}

export async function getAuditIntegrity(user: SessionUser) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<
      Array<{
        valid: boolean;
        event_count: number;
        root_previous_hash: string | null;
        head_hash: string | null;
      }>
    >`
      SELECT valid, event_count::integer, root_previous_hash, head_hash
      FROM verify_audit_chain_integrity(${user.tenantId}::uuid)
    `;
    const result = rows[0];
    return {
      valid: result?.valid ?? false,
      count: result?.event_count ?? 0,
      verifiedAt: new Date().toISOString(),
      rootPreviousHash: result?.root_previous_hash ?? null,
      headHash: result?.head_hash ?? null,
      scope: "full-chain" as const,
    };
  });
}

interface ReviewRow {
  target_id: string;
  matter_id: string;
  client: string;
  tax_type: string;
  tax_period: string;
  title: string;
  current_version: number;
  target_version: number;
  stored_artifact_hash: string | null;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  requested_by: string;
  reviewer: string;
  status: ReviewRequest["status"];
  expires_at: Date;
  request_hash: string;
  decision_note: string | null;
}

function mapReviewRequest(row: ReviewRow): ReviewRequest {
  const artifact = {
    targetId: row.target_id,
    matterId: row.matter_id,
    title: row.title,
    version: row.current_version,
    content: row.content,
    provenance: row.provenance,
  };
  const artifactHash = hashWorkpaperArtifact(artifact);
  return {
    ...artifact,
    client: row.client,
    taxType: row.tax_type,
    period: row.tax_period,
    requestedBy: row.requested_by,
    reviewer: row.reviewer,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    requestHash: row.request_hash,
    artifactHash,
    stale:
      artifactHash !== row.request_hash ||
      row.stored_artifact_hash !== row.request_hash ||
      row.current_version !== row.target_version,
    decisionNote: row.decision_note ?? undefined,
  };
}

const reviewSelect = `
  SELECT approval.target_id::text, workpaper.matter_id::text,
         client.name AS client, matter.tax_type, matter.tax_period,
         workpaper.title, workpaper.current_version, version.content,
         approval.target_version, version.artifact_hash AS stored_artifact_hash,
         version.provenance, requester.name AS requested_by,
         reviewer.name AS reviewer, approval.status, approval.expires_at,
         approval.request_hash, approval.decision_note
  FROM approvals approval
  JOIN workpapers workpaper
    ON workpaper.tenant_id = approval.tenant_id
   AND workpaper.id = approval.target_id
  JOIN workpaper_versions version
    ON version.tenant_id = workpaper.tenant_id
   AND version.workpaper_id = workpaper.id
   AND version.version = workpaper.current_version
  JOIN matters matter
    ON matter.tenant_id = workpaper.tenant_id
   AND matter.id = workpaper.matter_id
  JOIN clients client
    ON client.tenant_id = matter.tenant_id AND client.id = matter.client_id
  JOIN users requester ON requester.id = approval.requested_by
  JOIN users reviewer ON reviewer.id = approval.reviewer_id
  WHERE approval.tenant_id = $1
    AND approval.reviewer_id = $2
    AND approval.target_type = 'workpaper'
`;

export async function listReviewRequests(user: SessionUser) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<ReviewRow[]>(
      reviewSelect + " ORDER BY approval.created_at DESC LIMIT 100",
      [user.tenantId, user.id],
    );
    return rows.map(mapReviewRequest);
  });
}

export async function getReviewRequest(user: SessionUser, targetId: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<ReviewRow[]>(
      reviewSelect + " AND approval.target_id::text = $3 LIMIT 1",
      [user.tenantId, user.id, targetId],
    );
    return rows[0] ? mapReviewRequest(rows[0]) : undefined;
  });
}

export async function getReviewDecision(user: SessionUser, targetId: string) {
  const review = await getReviewRequest(user, targetId);
  return review && review.status !== "PENDING" && !review.stale
    ? {
        decision: review.status,
        reviewer: review.reviewer,
        note: review.decisionNote ?? "",
      }
    : undefined;
}

export async function getReviewArtifactHash(
  user: SessionUser,
  targetId: string,
) {
  const review = await getReviewRequest(user, targetId);
  return review &&
    review.status === "PENDING" &&
    !review.stale &&
    new Date(review.expiresAt).getTime() > Date.now()
    ? review.artifactHash
    : undefined;
}

async function artifactEvidenceIsCurrent(
  transaction: postgres.TransactionSql,
  tenantId: string,
  matterId: string,
  content: Record<string, unknown>,
) {
  const bindings = workpaperEvidenceBindings(content);
  if (!bindings) return false;
  const ids = bindings.map((binding) => binding.id);
  const expectedBindings = new Map(
    bindings.map((binding) => [binding.id, binding]),
  );
  const rows = await transaction<WorkpaperEvidenceRow[]>`
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
    WHERE chunk.tenant_id = ${tenantId}
      AND chunk.matter_id = ${matterId}
      AND chunk.id = ANY(${ids}::uuid[])
      AND chunk.is_current = true
      AND document.status = 'INDEXED'
      AND document.evidence_status = 'APPROVED'
      AND document.injection_scan_status = 'SAFE'
      AND document.object_version_id IS NOT NULL
      AND document.object_etag IS NOT NULL
      AND document.object_checksum_sha256 = document.checksum_sha256
  `;
  return (
    rows.length === bindings.length &&
    rows.every((row) => {
      const expected = expectedBindings.get(row.id);
      return (
        expected !== undefined &&
        workpaperEvidenceBindingMatches(
          expected,
          mapWorkpaperEvidenceBinding(row),
        )
      );
    })
  );
}

export async function setReviewDecision(
  user: SessionUser,
  targetId: string,
  input: {
    decision: "APPROVED" | "REJECTED";
    note: string;
    artifactHash: string;
    traceId: string;
    approvalToken?: string;
  },
) {
  if (reviewServiceIsConfigured()) {
    if (!input.approvalToken) return undefined;
    return decideWorkpaperViaReviewService(user, targetId, {
      ...input,
      approvalToken: input.approvalToken,
    });
  }
  return withReviewerTenantSql(user.tenantId, async (transaction) => {
    const artifactRows = await transaction<
      Array<{
        version: number;
        content: Record<string, unknown>;
        provenance: Record<string, unknown>;
        request_hash: string;
        artifact_hash: string | null;
        target_version: number;
        current_version: number;
        matter_id: string;
        title: string;
      }>
    >`
      SELECT version.version, version.content, version.provenance,
             approval.request_hash, version.artifact_hash,
             approval.target_version, workpaper.current_version,
             workpaper.matter_id::text, workpaper.title
      FROM approvals approval
      JOIN workpapers workpaper
        ON workpaper.tenant_id = approval.tenant_id
       AND workpaper.id = approval.target_id
      JOIN workpaper_versions version
        ON version.tenant_id = workpaper.tenant_id
       AND version.workpaper_id = workpaper.id
       AND version.version = workpaper.current_version
      WHERE approval.tenant_id = ${user.tenantId}
        AND approval.target_id::text = ${targetId}
        AND approval.target_type = 'workpaper'
        AND approval.reviewer_id = ${user.id}
        AND approval.status = 'PENDING'
        AND approval.expires_at > now()
    `;
    const artifact = artifactRows[0];
    if (!artifact) return undefined;
    const currentHash = hashWorkpaperArtifact({
      targetId,
      matterId: artifact.matter_id,
      title: artifact.title,
      version: artifact.version,
      content: artifact.content,
      provenance: artifact.provenance,
    });
    if (
      currentHash !== artifact.request_hash ||
      currentHash !== artifact.artifact_hash ||
      artifact.current_version !== artifact.target_version ||
      currentHash !== input.artifactHash
    ) {
      return undefined;
    }
    if (
      !(await artifactEvidenceIsCurrent(
        transaction,
        user.tenantId,
        artifact.matter_id,
        artifact.content,
      ))
    ) {
      return undefined;
    }
    const rows = await transaction<
      Array<{ decision: "APPROVED" | "REJECTED" }>
    >`
      SELECT decision
      FROM decide_workpaper_review(
        ${user.tenantId}::uuid, ${targetId}::uuid, ${user.id}::uuid,
        ${input.decision}, ${input.note}, ${input.artifactHash}, ${input.traceId}
      )
    `;
    const decided = rows[0];
    if (!decided) return undefined;
    return {
      decision: decided.decision,
      reviewer: user.name,
      note: input.note,
    };
  });
}

export async function appendAuditEvent(
  user: SessionUser,
  input: AuditWriteInput,
) {
  return withTenantSql(user.tenantId, (transaction) =>
    appendAuditEventTx(transaction, user, input),
  );
}

interface EvidenceRow {
  id: string;
  matter_id: string;
  document_id: string;
  document_name: string;
  page_number: number | null;
  section: string | null;
  content: string;
  content_hash: string;
  source_type: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  jurisdiction: string;
  effective_from: Date | null;
  effective_to: Date | null;
  source_publisher: string | null;
  source_uri: string | null;
  acquired_at: Date | null;
  score: number;
}

function fullTextQuery(query: string) {
  return query
    .normalize("NFKC")
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((token) => token.length > 1)
    .slice(0, 24)
    .map((token) => `${token}:*`)
    .join(" | ");
}

export async function searchEvidence(input: {
  tenantId: string;
  matterId: string;
  taxReferenceDate: string;
  query: string;
  limit: number;
  embedding?: number[];
}) {
  return withTenantSql(input.tenantId, async (transaction) => {
    const fts = fullTextQuery(input.query) || "__no_match__";
    const vectorValue = input.embedding
      ? `[${input.embedding.join(",")}]`
      : undefined;
    const candidateLimit = Math.min(input.limit * 8, 64);
    const configuredMinimum = Number(process.env.RAG_MIN_SCORE ?? "0.55");
    const minimumScore = Number.isFinite(configuredMinimum)
      ? Math.min(Math.max(configuredMinimum, 0), 1)
      : 0.55;
    const rows = vectorValue
      ? await transaction.unsafe<EvidenceRow[]>(
          `WITH vector_candidates AS (
             SELECT chunk.id
             FROM document_chunks chunk
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
             WHERE chunk.tenant_id = $1 AND chunk.matter_id::text = $2
               AND chunk.is_current = true AND chunk.jurisdiction = 'KR'
               AND document.status = 'INDEXED'
               AND document.evidence_status = 'APPROVED'
               AND document.injection_scan_status = 'SAFE'
               AND chunk.embedding IS NOT NULL
               AND (
                 chunk.source_type = 'BUSINESS_RECORD'
                 OR (
                   chunk.source_type IN ('TAX_AUTHORITY', 'INTERNAL_POLICY')
                   AND chunk.effective_from IS NOT NULL
                   AND chunk.effective_from <= $8::timestamptz
                   AND (chunk.effective_to IS NULL OR chunk.effective_to > $8::timestamptz)
                 )
               )
             ORDER BY chunk.embedding <=> $4::vector
             LIMIT $6
           ), text_candidates AS (
             SELECT chunk.id
             FROM document_chunks chunk
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
             WHERE chunk.tenant_id = $1 AND chunk.matter_id::text = $2
               AND chunk.is_current = true AND chunk.jurisdiction = 'KR'
               AND document.status = 'INDEXED'
               AND document.evidence_status = 'APPROVED'
               AND document.injection_scan_status = 'SAFE'
               AND (
                 chunk.source_type = 'BUSINESS_RECORD'
                 OR (
                   chunk.source_type IN ('TAX_AUTHORITY', 'INTERNAL_POLICY')
                   AND chunk.effective_from IS NOT NULL
                   AND chunk.effective_from <= $8::timestamptz
                   AND (chunk.effective_to IS NULL OR chunk.effective_to > $8::timestamptz)
                 )
               )
               AND to_tsvector('simple', chunk.content) @@ to_tsquery('simple', $3)
             ORDER BY ts_rank_cd(to_tsvector('simple', chunk.content),
                                 to_tsquery('simple', $3)) DESC
             LIMIT $6
           ), candidate_ids AS (
             SELECT id FROM vector_candidates
             UNION
             SELECT id FROM text_candidates
           ), ranked AS (
             SELECT chunk.id::text, chunk.matter_id::text,
                    chunk.document_id::text,
                    document.original_name AS document_name,
                    chunk.page_number, chunk.section, chunk.content,
                    chunk.content_hash, chunk.source_type, chunk.jurisdiction,
                    chunk.effective_from, chunk.effective_to,
                    document.source_publisher, document.source_uri,
                    document.acquired_at,
                    CASE
                      WHEN chunk.embedding IS NULL THEN LEAST(ts_rank_cd(
                        to_tsvector('simple', chunk.content),
                        to_tsquery('simple', $3)
                      ) * 4, 1)::float
                      ELSE (0.65 * (1 - (chunk.embedding <=> $4::vector)) +
                        0.35 * LEAST(ts_rank_cd(
                          to_tsvector('simple', chunk.content),
                          to_tsquery('simple', $3)
                        ) * 4, 1))::float
                    END AS score
             FROM candidate_ids candidate
             JOIN document_chunks chunk ON chunk.id = candidate.id
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
           )
           SELECT * FROM ranked
           WHERE score >= $7
           ORDER BY score DESC
           LIMIT $5`,
          [
            input.tenantId,
            input.matterId,
            fts,
            vectorValue,
            input.limit,
            candidateLimit,
            minimumScore,
            input.taxReferenceDate,
          ],
        )
      : await transaction.unsafe<EvidenceRow[]>(
          `WITH ranked AS (
             SELECT chunk.id::text, chunk.matter_id::text,
                    chunk.document_id::text,
                    document.original_name AS document_name,
                    chunk.page_number, chunk.section, chunk.content,
                    chunk.content_hash, chunk.source_type, chunk.jurisdiction,
                    chunk.effective_from, chunk.effective_to,
                    document.source_publisher, document.source_uri,
                    document.acquired_at,
                    LEAST(ts_rank_cd(to_tsvector('simple', chunk.content),
                                     to_tsquery('simple', $3)) * 4, 1)::float AS score
             FROM document_chunks chunk
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
             WHERE chunk.tenant_id = $1 AND chunk.matter_id::text = $2
               AND chunk.is_current = true AND document.status = 'INDEXED'
               AND document.evidence_status = 'APPROVED'
               AND document.injection_scan_status = 'SAFE'
               AND chunk.jurisdiction = 'KR'
               AND (
                 chunk.source_type = 'BUSINESS_RECORD'
                 OR (
                   chunk.source_type IN ('TAX_AUTHORITY', 'INTERNAL_POLICY')
                   AND chunk.effective_from IS NOT NULL
                   AND chunk.effective_from <= $5::timestamptz
                   AND (chunk.effective_to IS NULL OR chunk.effective_to > $5::timestamptz)
                 )
               )
               AND to_tsvector('simple', chunk.content) @@ to_tsquery('simple', $3)
           )
           SELECT * FROM ranked
           WHERE score >= $6
           ORDER BY score DESC
           LIMIT $4`,
          [
            input.tenantId,
            input.matterId,
            fts,
            input.limit,
            input.taxReferenceDate,
            minimumScore,
          ],
        );
    return rows.map(
      (row) =>
        ({
          id: row.id,
          tenantId: input.tenantId,
          matterId: row.matter_id,
          documentId: row.document_id,
          documentName: row.document_name,
          page: row.page_number,
          section: row.section ?? "문서 본문",
          excerpt: row.content,
          contentHash: row.content_hash,
          sourceType: row.source_type,
          jurisdiction: row.jurisdiction,
          effectiveFrom: row.effective_from?.toISOString() ?? null,
          effectiveTo: row.effective_to?.toISOString() ?? null,
          sourcePublisher: row.source_publisher,
          sourceUri: row.source_uri,
          acquiredAt: row.acquired_at?.toISOString() ?? null,
          effectiveDate:
            row.effective_from?.toISOString().slice(0, 10) ?? "unknown",
          score: Number(Number(row.score).toFixed(3)),
        }) satisfies Evidence,
    );
  });
}
