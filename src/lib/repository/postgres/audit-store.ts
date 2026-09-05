import "server-only";
import {
  auditDateBounds,
  auditQuerySchema,
  escapeLike,
  type AuditQuery,
  type PageResult,
} from "@/lib/contracts/listing";
import { matchingAuditActions } from "@/lib/ui/labels";

import type postgres from "postgres";
import { withTenantSql } from "@/lib/db/client";
import type { AuditEvent, SessionUser } from "@/lib/domain/types";

export interface AuditWriteInput {
  action: string;
  targetType: string;
  targetId: string;
  outcome: AuditEvent["outcome"];
  traceId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export async function appendAuditEventTx(
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

interface AuditRow {
  id: string;
  tenant_id: string;
  occurred_at: Date;
  actor_id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  outcome: AuditEvent["outcome"];
  trace_id: string;
  metadata: Record<string, string | number | boolean | null>;
  previous_hash: string;
  hash: string;
}
function mapAudit(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    actor: row.actor,
    targetType: row.target_type,
    metadata: row.metadata,
    occurredAt: row.occurred_at.toISOString(),
    action: row.action,
    target: row.target_id,
    outcome: row.outcome,
    traceId: row.trace_id,
    ipMasked: "not-recorded",
    prevHash: row.previous_hash,
    hash: row.hash,
  };
}

export async function queryAuditEvents(
  user: SessionUser,
  query: AuditQuery,
): Promise<PageResult<AuditEvent>> {
  const bounds = auditDateBounds(query);
  return withTenantSql(user.tenantId, async (transaction) => {
    const actions = matchingAuditActions(query.q);
    const values = [
      user.tenantId,
      `%${escapeLike(query.q)}%`,
      query.outcome,
      bounds.from,
      bounds.to,
      actions,
    ];
    const from = `FROM audit_events e LEFT JOIN users u ON u.id::text = e.actor_id
      WHERE e.tenant_id = $1 AND ($3 = 'ALL' OR e.outcome::text = $3)
      AND ($4::timestamptz IS NULL OR e.occurred_at >= $4::timestamptz)
      AND ($5::timestamptz IS NULL OR e.occurred_at < $5::timestamptz)
      AND (concat_ws(' ', u.name, e.actor_id::text, e.action, e.target_id::text, e.trace_id) ILIKE $2 OR e.action = ANY($6::text[]))`;
    const counts = await transaction.unsafe<{ total: number }[]>(
      `SELECT count(*)::int AS total ${from}`,
      values,
    );
    const rows = await transaction.unsafe<AuditRow[]>(
      `SELECT e.id::text, e.tenant_id::text, e.occurred_at,
      e.actor_id::text, coalesce(u.name, e.actor_id::text) AS actor, e.action, e.target_type,
      e.target_id::text, e.outcome, e.trace_id, e.metadata, e.previous_hash, e.hash ${from}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT $7 OFFSET $8`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      items: rows.map(mapAudit),
      total: counts[0]?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

// Retained for small operational summaries; the searchable UI uses queryAuditEvents.
export async function listAuditEvents(user: SessionUser) {
  return (
    await queryAuditEvents(user, auditQuerySchema.parse({ pageSize: 100 }))
  ).items;
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

export async function appendAuditEvent(
  user: SessionUser,
  input: AuditWriteInput,
) {
  return withTenantSql(user.tenantId, (transaction) =>
    appendAuditEventTx(transaction, user, input),
  );
}
