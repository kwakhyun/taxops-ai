import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { matterQuerySchema } from "@/lib/contracts/listing";
import { searchMatters } from "@/lib/repository";
import { apiError, requestIdFrom } from "@/lib/http/errors";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "case:read");
    const query = matterQuerySchema.parse({
      q: new URL(request.url).searchParams.get("q") ?? "",
      pageSize: 9,
    });
    const { items, ...meta } = await searchMatters(user, query);
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
