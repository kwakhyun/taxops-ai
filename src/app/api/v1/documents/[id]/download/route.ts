import { getSessionUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/rbac";
import {
  attachmentContentDisposition,
  type DocumentDownloadDescriptor,
} from "@/lib/files/download";
import { getStoredObject } from "@/lib/files/object-storage";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { getDocumentDownload } from "@/lib/repository";
import { writeLog } from "@/lib/observability/logger";

export const runtime = "nodejs";

function notFound(requestId: string) {
  return Response.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "다운로드할 수 있는 자료를 찾지 못했습니다.",
      },
      meta: { requestId },
    },
    { status: 404, headers: { "x-request-id": requestId } },
  );
}

async function resolveBody(document: DocumentDownloadDescriptor) {
  if (document.demoBytes) {
    const bytes = Uint8Array.from(document.demoBytes);
    return {
      body: bytes.buffer,
      contentType: document.mimeType,
      contentLength: bytes.byteLength,
    };
  }
  if (!document.objectKey) return undefined;
  const stored = await getStoredObject({
    objectKey: document.objectKey,
    objectVersionId: document.objectVersionId,
    checksumSha256: document.objectChecksumSha256,
  });
  if (!stored) return undefined;
  return {
    ...stored,
    body:
      stored.body instanceof Uint8Array
        ? Uint8Array.from(stored.body).buffer
        : stored.body,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = requestIdFrom(request);
  try {
    const user = await getSessionUser();
    requirePermission(user, "document:read");
    const { id } = await params;
    const document = await getDocumentDownload(user, id);
    if (!document) return notFound(requestId);
    const stored = await resolveBody(document);
    if (!stored) return notFound(requestId);
    writeLog("info", "document.downloaded", {
      requestId,
      tenantId: user.tenantId,
      actorId: user.id,
      targetType: "document",
      targetId: id,
      outcome: "SUCCESS",
    });
    return new Response(stored.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": attachmentContentDisposition(document.name),
        "content-length": String(stored.contentLength),
        "content-type": stored.contentType ?? document.mimeType,
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return apiError(error, requestId);
  }
}
