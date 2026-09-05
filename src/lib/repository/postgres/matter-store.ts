import "server-only";
import {
  escapeLike,
  type MatterQuery,
  type MatterSearchItem,
  type PageResult,
} from "@/lib/contracts/listing";

import type { CreateMatterInput } from "@/lib/contracts/cases";
import { withTenantSql } from "@/lib/db/client";
import type { Matter, MatterAnalysis, SessionUser } from "@/lib/domain/types";
import { appendAuditEventTx } from "@/lib/repository/postgres/audit-store";
import { displayDate } from "@/lib/repository/postgres/date-format";
import { RepositoryInputError } from "@/lib/repository/postgres/errors";
import { workpaperEvidenceBindings } from "@/lib/workpapers/artifact";
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
    openFindings: null,
    evidenceCoverage: total ? Math.round((indexed / total) * 100) : 0,
    updatedAt: displayDate(row.updated_at),
    summary: row.summary,
  };
}

const matterSelect = `
  SELECT m.id::text, c.name AS client, m.tax_type, m.tax_period,
         owner.name AS owner, reviewer.name AS reviewer, m.status, m.risk,
         m.due_at, m.updated_at, m.summary,
         count(d.id)::int AS document_count,
         count(d.id) FILTER (WHERE d.status = 'INDEXED' AND d.evidence_status = 'APPROVED')::int AS indexed_count
  FROM matters m
  JOIN clients c ON c.tenant_id = m.tenant_id AND c.id = m.client_id
  JOIN users owner ON owner.id = m.owner_id
  JOIN users reviewer ON reviewer.id = m.reviewer_id
  LEFT JOIN documents d ON d.tenant_id = m.tenant_id AND d.matter_id = m.id
`;

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
    ["RETRIEVE", "근거 검색", "현재 세무 업무의 승인된 근거 검색"],
    ["DRAFT", "분석 초안", "결정론적 계산과 세무 분석 초안 생성"],
    ["VERIFY", "독립 검증", "주장, 계산, 출처 바인딩 검증"],
    ["AWAITING_REVIEW", "전문가 검토", "검토자 결정 전 외부 반영 차단"],
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
          AND version.provenance->>'runId' = run.id::text
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
        question: "저장된 세무 업무 분석 실행",
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
        "현재 업무 공간에서 검토자를 찾을 수 없습니다.",
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
      openFindings: null,
      evidenceCoverage: 0,
      updatedAt: "방금 전",
      summary: input.summary,
    } satisfies Matter;
  });
}

export async function queryMatters(
  user: SessionUser,
  query: MatterQuery,
): Promise<PageResult<Matter>> {
  return withTenantSql(user.tenantId, async (transaction) => {
    const values = [user.tenantId, `%${escapeLike(query.q)}%`, query.risk];
    const where =
      "m.tenant_id = $1 AND concat_ws(' ', c.name, m.tax_type, m.tax_period, m.summary) ILIKE $2 AND ($3 = 'ALL' OR m.risk::text = $3)";
    const counts = await transaction.unsafe<{ total: number }[]>(
      `SELECT count(*)::int AS total FROM matters m JOIN clients c ON c.tenant_id = m.tenant_id AND c.id = m.client_id WHERE ${where}`,
      values,
    );
    const rows = await transaction.unsafe<MatterRow[]>(
      `WITH selected_matters AS (
      SELECT m.* FROM matters m JOIN clients c ON c.tenant_id = m.tenant_id AND c.id = m.client_id
      WHERE ${where} ORDER BY m.updated_at DESC, m.id DESC LIMIT $4 OFFSET $5
    ) ${matterSelect.replace("FROM matters m", "FROM selected_matters m")}
      GROUP BY m.id, m.tax_type, m.tax_period, m.status, m.risk, m.due_at, m.updated_at, m.summary, c.name, owner.name, reviewer.name
      ORDER BY m.updated_at DESC, m.id DESC`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      items: rows.map(mapMatter),
      total: counts[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

// Search returns only navigation fields and never joins or aggregates documents.
export async function searchMatters(
  user: SessionUser,
  query: MatterQuery,
): Promise<PageResult<MatterSearchItem>> {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<
      {
        id: string;
        client: string;
        taxType: string;
        period: string;
        summary: string;
      }[]
    >`
      SELECT m.id::text, c.name AS client, m.tax_type AS "taxType", m.tax_period AS period, m.summary
      FROM matters m JOIN clients c ON c.tenant_id = m.tenant_id AND c.id = m.client_id
      WHERE m.tenant_id = ${user.tenantId}
        AND concat_ws(' ', c.name, m.tax_type, m.tax_period, m.summary) ILIKE ${`%${escapeLike(query.q)}%`}
      ORDER BY m.updated_at DESC, m.id DESC LIMIT ${query.pageSize}
    `;
    return {
      items: rows,
      total: rows.length,
      page: 1,
      pageSize: query.pageSize,
    };
  });
}
