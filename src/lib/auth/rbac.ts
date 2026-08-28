import type { Permission, Role, SessionUser } from "@/lib/domain/types";

const permissionsByRole: Record<Role, ReadonlySet<Permission>> = {
  ANALYST: new Set([
    "case:read",
    "case:write",
    "document:read",
    "document:upload",
    "assistant:run",
  ]),
  REVIEWER: new Set([
    "case:read",
    "case:write",
    "document:read",
    "document:upload",
    "assistant:run",
    "workpaper:review",
    "audit:read",
  ]),
  ADMIN: new Set([
    "case:read",
    "case:write",
    "document:read",
    "document:upload",
    "authority:ingest",
    "assistant:run",
    "workpaper:review",
    "member:manage",
    "audit:read",
  ]),
};

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(
    message: string,
    readonly code: "FORBIDDEN" | "TENANT_MISMATCH" = "FORBIDDEN",
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function can(user: SessionUser, permission: Permission) {
  return permissionsByRole[user.role].has(permission);
}

export function requirePermission(user: SessionUser, permission: Permission) {
  if (!can(user, permission)) {
    throw new AuthorizationError(`Permission denied: ${permission}`);
  }
}

export function requireTenant(user: SessionUser, resourceTenantId: string) {
  if (user.tenantId !== resourceTenantId) {
    throw new AuthorizationError(
      "Resource is outside the active tenant",
      "TENANT_MISMATCH",
    );
  }
}

export function authorizeResource(
  user: SessionUser,
  permission: Permission,
  resourceTenantId: string,
) {
  requireTenant(user, resourceTenantId);
  requirePermission(user, permission);
}

export function getPermissions(role: Role) {
  return [...permissionsByRole[role]];
}
