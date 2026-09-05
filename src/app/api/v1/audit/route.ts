import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { queryAuditEvents } from "@/lib/repository";

import { auditQuerySchema } from "@/lib/contracts/listing";
import { buildAuditCsv } from "@/lib/ui/audit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "audit:read");
    const params = new URL(request.url).searchParams;
    const query = auditQuerySchema.parse(Object.fromEntries(params));
    const csv = params.get("format") === "csv";
    const result = await queryAuditEvents(
      user,
      csv ? { ...query, page: 1, pageSize: 10001 } : query,
    );
    if (csv) {
      if (result.total > 10000)
        return Response.json(
          {
            error: {
              code: "EXPORT_TOO_LARGE",
              message:
                "내보내기는 10,000건까지 가능합니다. 날짜 또는 검색 조건을 좁혀 주세요.",
            },
            meta: { requestId },
          },
          {
            status: 422,
            headers: {
              "x-request-id": requestId,
              "Cache-Control": "private, no-store",
            },
          },
        );
      return new Response(buildAuditCsv(result.items), {
        headers: {
          "Content-Type": "text/csv;charset=utf-8",
          "Content-Disposition": 'attachment; filename="taxops-audit.csv"',
          "Cache-Control": "private, no-store",
          "x-request-id": requestId,
        },
      });
    }
    const { items, ...meta } = result;
    return Response.json(
      { data: items, meta: { ...meta, requestId } },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "x-request-id": requestId,
        },
      },
    );
  } catch (error) {
    return apiError(error, requestId);
  }
}
