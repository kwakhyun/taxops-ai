import "server-only";

import { withTenantSql } from "@/lib/db/client";
import { AuthenticationError } from "@/lib/auth/session-error";

export interface WebSessionBinding {
  id: string;
  tenantId: string;
  oidcSubject: string;
  expiresAt: Date;
}

export async function registerWebSession(input: WebSessionBinding) {
  await withTenantSql(input.tenantId, async (transaction) => {
    await transaction`
      DELETE FROM web_sessions
      WHERE tenant_id = ${input.tenantId}
        AND expires_at < now() - interval '7 days'
    `;
    await transaction`
      INSERT INTO web_sessions (
        id, tenant_id, oidc_subject, expires_at
      ) VALUES (
        ${input.id}::uuid, ${input.tenantId}::uuid,
        ${input.oidcSubject}, ${input.expiresAt}
      )
    `;
  });
}

export async function assertWebSessionActive(input: {
  id: string;
  tenantId: string;
  oidcSubject: string;
}) {
  const active = await withTenantSql(input.tenantId, async (transaction) => {
    const rows = await transaction<{ id: string }[]>`
      SELECT id::text
      FROM web_sessions
      WHERE id::text = ${input.id}
        AND tenant_id = ${input.tenantId}::uuid
        AND oidc_subject = ${input.oidcSubject}
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1
    `;
    return rows[0];
  });
  if (!active) {
    throw new AuthenticationError("OIDC session was revoked or expired");
  }
}

export async function revokeWebSession(input: {
  id: string;
  tenantId: string;
  oidcSubject: string;
}) {
  await withTenantSql(input.tenantId, async (transaction) => {
    await transaction`
      UPDATE web_sessions
      SET revoked_at = coalesce(revoked_at, now())
      WHERE id::text = ${input.id}
        AND tenant_id = ${input.tenantId}::uuid
        AND oidc_subject = ${input.oidcSubject}
    `;
  });
}
