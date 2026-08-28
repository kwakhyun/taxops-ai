import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import { uploadMetadataSchema, validateFile } from "@/lib/files/validation";
import { putQuarantinedObject } from "@/lib/files/object-storage";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { enqueueDocument, findMatter } from "@/lib/repository";
import { createTraceId, writeLog } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
const maximumMultipartBytes = 16 * 1024 * 1024;

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "document:upload");
    await rateLimit(
      `${user.tenantId}:${user.id}:upload`,
      20,
      60 * 60_000,
      user.tenantId,
    );
    const contentLength = request.headers.get("content-length");
    const declaredLength = Number(contentLength ?? 0);
    if (
      process.env.NODE_ENV === "production" &&
      (!contentLength ||
        !Number.isFinite(declaredLength) ||
        declaredLength <= 0)
    ) {
      return Response.json(
        {
          error: {
            code: "LENGTH_REQUIRED",
            message: "업로드 요청에 Content-Length가 필요합니다.",
          },
          meta: { requestId },
        },
        { status: 411, headers: { "x-request-id": requestId } },
      );
    }
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maximumMultipartBytes
    ) {
      return Response.json(
        {
          error: {
            code: "PAYLOAD_TOO_LARGE",
            message: "업로드 요청은 16MB를 넘을 수 없습니다.",
          },
          meta: { requestId },
        },
        { status: 413, headers: { "x-request-id": requestId } },
      );
    }
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return Response.json(
        {
          error: {
            code: "FILE_REQUIRED",
            message: "업로드할 파일이 필요합니다.",
          },
          meta: { requestId },
        },
        { status: 400, headers: { "x-request-id": requestId } },
      );
    }

    const metadata = uploadMetadataSchema.parse({
      matterId: formData.get("matterId"),
      idempotencyKey: request.headers.get("idempotency-key"),
      sourceType: formData.get("sourceType") ?? "BUSINESS_RECORD",
      sourcePublisher: formData.get("sourcePublisher") || undefined,
      sourceUri: formData.get("sourceUri") || undefined,
    });
    if (metadata.sourceType === "TAX_AUTHORITY") {
      requirePermission(user, "authority:ingest");
    }
    if (!(await findMatter(user, metadata.matterId))) {
      return Response.json(
        {
          error: { code: "NOT_FOUND", message: "케이스를 찾을 수 없습니다." },
          meta: { requestId },
        },
        { status: 404, headers: { "x-request-id": requestId } },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const validated = validateFile({
      name: file.name,
      type: file.type,
      size: file.size,
      bytes,
    });
    const stored = await putQuarantinedObject({
      tenantId: user.tenantId,
      matterId: metadata.matterId,
      bytes,
      contentType: validated.mimeType,
      checksum: validated.checksum,
    });
    const traceId = createTraceId();
    let result;
    try {
      result = await enqueueDocument(user, {
        matterId: metadata.matterId,
        name: validated.name,
        mimeType: validated.mimeType,
        size: validated.size,
        checksum: validated.checksum,
        objectKey: stored.objectKey,
        objectVersionId: stored.objectVersionId,
        objectEtag: stored.objectEtag,
        objectChecksumSha256: stored.objectChecksumSha256,
        idempotencyKey: metadata.idempotencyKey,
        traceId,
        sourceType: metadata.sourceType,
        sourcePublisher: metadata.sourcePublisher,
        sourceUri: metadata.sourceUri,
        acquiredAt:
          metadata.sourceType === "TAX_AUTHORITY"
            ? new Date().toISOString()
            : undefined,
      });
      if (result.deduplicated) await stored.cleanup();
    } catch (error) {
      await stored.cleanup();
      throw error;
    }

    writeLog("info", "document.queued", {
      requestId,
      tenantId: user.tenantId,
      actorId: user.id,
      targetType: "document",
      targetId: result.document.id,
      jobId: result.job.id,
      outcome: "SUCCESS",
    });

    return Response.json(
      { data: result, meta: { requestId } },
      {
        status: result.deduplicated ? 200 : 202,
        headers: { "x-request-id": requestId },
      },
    );
  } catch (error) {
    writeLog("warn", "document.queue_failed", {
      requestId,
      errorCode: "UPLOAD_REJECTED",
    });
    return apiError(error, requestId);
  }
}
