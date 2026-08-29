import "server-only";

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

export async function appendAuditEvent(
  user: SessionUser,
  input: AuditWriteInput,
) {
  return withTenantSql(user.tenantId, (transaction) =>
    appendAuditEventTx(transaction, user, input),
  );
}
