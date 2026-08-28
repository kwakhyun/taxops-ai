import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { getJob } from "@/lib/repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "document:read");
    const { id } = await params;
    const job = await getJob(user, id);
    if (!job) {
      return Response.json(
        {
          error: { code: "NOT_FOUND", message: "작업을 찾을 수 없습니다." },
          meta: { requestId },
        },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    return Response.json({ data: job, meta: { requestId } });
  } catch (error) {
    return apiError(error, requestId);
  }
}
