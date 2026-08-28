import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { writeLog } from "@/lib/observability/logger";
import {
  getReviewArtifactHash,
  getReviewDecision,
  getReviewRequest,
  setReviewDecision,
} from "@/lib/repository";
import { createTraceId } from "@/lib/observability/logger";
import {
  issueApprovalToken,
  verifyApprovalToken,
} from "@/lib/security/approval-token";
import {
  issueWorkpaperApprovalTokensViaReviewService,
  reviewServiceIsConfigured,
} from "@/lib/review/service-client";

export const runtime = "nodejs";

const decisionSchema = z.strictObject({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().min(4).max(800),
  token: z.string().min(20),
  artifactHash: z.string().length(64),
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
    const decision = await getReviewDecision(user, id);
    if (decision) {
      return Response.json({
        data: { targetId: id, decision },
        meta: { requestId },
      });
    }
    const review = await getReviewRequest(user, id);
    if (!review) {
      return Response.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "처리 가능한 검토 요청을 찾을 수 없습니다.",
          },
          meta: { requestId },
        },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }
    if (review.stale) {
      return Response.json(
        {
          error: {
            code: "ARTIFACT_CHANGED",
            message: "워크페이퍼가 변경되어 새 승인 요청이 필요합니다.",
          },
          meta: { requestId },
        },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    const activeArtifactHash = await getReviewArtifactHash(user, id);
    if (!activeArtifactHash) {
      return Response.json(
        {
          error: {
            code: "REVIEW_EXPIRED",
            message: "승인 요청이 만료됐습니다.",
          },
          meta: { requestId },
        },
        { status: 410, headers: { "x-request-id": requestId } },
      );
    }
    const serviceTokens = reviewServiceIsConfigured()
      ? await issueWorkpaperApprovalTokensViaReviewService(
          user,
          id,
          activeArtifactHash,
        )
      : undefined;
    if (reviewServiceIsConfigured() && !serviceTokens) {
      return Response.json(
        {
          error: {
            code: "REVIEW_TOKEN_UNAVAILABLE",
            message: "승인 권한 증명을 발급할 수 없습니다.",
          },
          meta: { requestId },
        },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    return Response.json({
      data: {
        targetId: id,
        artifactHash: activeArtifactHash,
        tokens: serviceTokens?.tokens ?? {
          APPROVED: issueApprovalToken({
            actorId: user.id,
            targetId: id,
            artifactHash: activeArtifactHash,
            decision: "APPROVED",
          }),
          REJECTED: issueApprovalToken({
            actorId: user.id,
            targetId: id,
            artifactHash: activeArtifactHash,
            decision: "REJECTED",
          }),
        },
        expiresInSeconds: serviceTokens?.expiresInSeconds ?? 300,
        decision: undefined,
      },
      meta: { requestId },
    });
  } catch (error) {
    return apiError(error, requestId);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "workpaper:review");
    const { id } = await params;
    const input = decisionSchema.parse(await request.json());
    const activeArtifactHash = await getReviewArtifactHash(user, id);
    if (!activeArtifactHash || activeArtifactHash !== input.artifactHash) {
      return Response.json(
        {
          error: {
            code: "ARTIFACT_CHANGED",
            message: "승인 대상 버전이 변경됐거나 요청이 만료됐습니다.",
          },
          meta: { requestId },
        },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    if (!reviewServiceIsConfigured()) {
      verifyApprovalToken(input.token, {
        actorId: user.id,
        targetId: id,
        artifactHash: input.artifactHash,
        decision: input.decision,
      });
    }
    const traceId = createTraceId();
    const decision = await setReviewDecision(user, id, {
      decision: input.decision,
      note: input.note,
      artifactHash: input.artifactHash,
      traceId,
      approvalToken: input.token,
    });
    if (!decision) {
      return Response.json(
        {
          error: {
            code: "ALREADY_DECIDED",
            message: "이미 처리된 검토 요청입니다.",
          },
          meta: { requestId },
        },
        { status: 409, headers: { "x-request-id": requestId } },
      );
    }
    writeLog("info", "workpaper.reviewed", {
      requestId,
      tenantId: user.tenantId,
      actorId: user.id,
      action: input.decision,
      targetType: "workpaper",
      targetId: id,
      outcome: "SUCCESS",
    });
    return Response.json({ data: decision, meta: { requestId } });
  } catch (error) {
    return apiError(error, requestId);
  }
}
