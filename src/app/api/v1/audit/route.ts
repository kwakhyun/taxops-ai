import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { listAuditEvents } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "audit:read");
    return Response.json({
      data: await listAuditEvents(user),
      meta: { requestId },
    });
  } catch (error) {
    return apiError(error, requestId);
  }
}
