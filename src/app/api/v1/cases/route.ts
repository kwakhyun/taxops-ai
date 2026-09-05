import { createMatterSchema } from "@/lib/contracts/cases";
import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { createMatter, queryMatters } from "@/lib/repository";
import { createTraceId } from "@/lib/observability/logger";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { writeLog } from "@/lib/observability/logger";

import { matterQuerySchema } from "@/lib/contracts/listing";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "case:read");
    const query = matterQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const { items, ...meta } = await queryMatters(user, query);
    return Response.json(
      { data: items, meta: { requestId, ...meta } },
      {
        headers: {
          "x-request-id": requestId,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return apiError(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "case:write");
    const input = createMatterSchema.parse(await request.json());
    const traceId = createTraceId();
    const matter = await createMatter(user, input, traceId);
    writeLog("info", "matter.created", {
      requestId,
      tenantId: user.tenantId,
      actorId: user.id,
      targetType: "matter",
      targetId: matter.id,
      outcome: "SUCCESS",
    });
    return Response.json(
      { data: matter, meta: { requestId } },
      { status: 201, headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    writeLog("warn", "matter.create_failed", {
      requestId,
      errorCode: "CREATE_FAILED",
    });
    return apiError(error, requestId);
  }
}
