import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { buildMattersCsv } from "@/lib/export/matters-csv";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { listMatters } from "@/lib/repository";
import { writeLog } from "@/lib/observability/logger";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "case:read");
    const csv = buildMattersCsv(await listMatters(user));
    writeLog("info", "matter.list_exported", {
      requestId,
      tenantId: user.tenantId,
      actorId: user.id,
      targetType: "matter-list",
      outcome: "SUCCESS",
    });
    return new Response(csv, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition":
          "attachment; filename=tax-matters.csv; filename*=UTF-8''tax-matters.csv",
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return apiError(error, requestId);
  }
}
