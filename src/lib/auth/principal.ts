import "server-only";

import { z } from "zod";
import { withTenantSql } from "@/lib/db/client";
import type { Role, SessionUser } from "@/lib/domain/types";
import { AuthenticationError } from "@/lib/auth/session-error";

const tenantIdSchema = z.string().uuid();

export async function resolveOidcPrincipal(input: {
  subject: string;
  tenantClaim: string;
}): Promise<SessionUser> {
  const parsedTenant = tenantIdSchema.safeParse(input.tenantClaim);
  if (!parsedTenant.success)
    throw new AuthenticationError("OIDC tenant claim is invalid");

  return withTenantSql(parsedTenant.data, async (transaction) => {
    const rows = await transaction<
      Array<{
        id: string;
        tenant_id: string;
        tenant_name: string;
        email: string;
        name: string;
        role: Role;
      }>
    >`
      SELECT account.id::text, membership.tenant_id::text,
             tenant.name AS tenant_name,
             account.email, account.name, membership.role
      FROM users account
      JOIN memberships membership ON membership.user_id = account.id
      JOIN tenants tenant ON tenant.id = membership.tenant_id
      WHERE account.oidc_subject = ${input.subject}
        AND membership.tenant_id = ${parsedTenant.data}
      LIMIT 1
    `;
    const principal = rows[0];
    if (!principal)
      throw new AuthenticationError("User is not provisioned for this tenant");
    return {
      id: principal.id,
      tenantId: principal.tenant_id,
      tenantName: principal.tenant_name,
      email: principal.email,
      name: principal.name,
      role: principal.role,
      initials: principal.name.slice(0, 1),
    };
  });
}
