import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import {
  getDocumentEvidenceReview,
  setDocumentEvidenceDecision,
} from "@/lib/repository";
import { createTraceId, writeLog } from "@/lib/observability/logger";

export const runtime = "nodejs";

const decisionSchema = z.strictObject({
  decision: z.enum(["APPROVED", "REJECTED"]),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "workpaper:review");
    const { id } = await params;
    const preview = await getDocumentEvidenceReview(user, id);
    if (!preview) {
      return Response.json(
        {
          error: {
            code: "DOCUMENT_NOT_REVIEWABLE",
            message:
              "자료 등록자와 다른 담당 검토자만 검토 대기 자료를 처리할 수 있습니다.",
          },
          meta: { requestId },
        },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    return Response.json(
      { data: preview, meta: { requestId } },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiError(error, requestId);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "workpaper:review");
    const { id } = await params;
    const { decision, checksumSha256, manifestSha256 } = decisionSchema.parse(
      await request.json(),
    );
    const traceId = createTraceId();
    const document = await setDocumentEvidenceDecision(
      user,
      id,
      decision,
      checksumSha256,
      manifestSha256,
      traceId,
    );
    if (!document) {
      return Response.json(
        {
          error: {
            code: "DOCUMENT_NOT_REVIEWABLE",
            message:
              "담당 검토자, 자료 등록자 분리, 파일 해시와 대기 상태를 다시 확인해 주세요.",
          },
          meta: { requestId },
        },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    writeLog("info", "document.evidence_reviewed", {
      requestId,
      traceId,
      tenantId: user.tenantId,
      actorId: user.id,
      targetType: "document",
      targetId: document.id,
      action: decision,
      outcome: "SUCCESS",
    });
    return Response.json(
      { data: document, meta: { requestId } },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return apiError(error, requestId);
  }
}
