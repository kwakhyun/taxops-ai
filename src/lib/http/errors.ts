import { ZodError } from "zod";
import { AuthenticationError } from "@/lib/auth/session-error";
import { AuthorizationError } from "@/lib/auth/rbac";
import { FileValidationError } from "@/lib/files/validation";
import { logServerError, writeLog } from "@/lib/observability/logger";

export function apiError(error: unknown, requestId?: string) {
  if (error instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          fields: error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
        meta: requestId ? { requestId } : undefined,
      },
      {
        status: 400,
        headers: requestId ? { "x-request-id": requestId } : undefined,
      },
    );
  }
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError
  ) {
    writeLog("warn", "security.access_denied", {
      requestId,
      statusCode: error.status,
      errorCode: error.code,
      outcome: "DENIED",
    });
    return Response.json(
      {
        error: {
          code: error.code,
          message:
            error instanceof AuthenticationError
              ? error.code === "REVIEW_REAUTH_REQUIRED"
                ? error.message
                : "인증 정보가 유효하지 않거나 만료되었습니다. 다시 로그인해 주세요."
              : "이 작업을 처리할 권한이 없습니다. 담당 관리자에게 문의해 주세요.",
        },
        meta: requestId ? { requestId } : undefined,
      },
      {
        status: error.status,
        headers: {
          ...(requestId ? { "x-request-id": requestId } : {}),
          "Cache-Control": "no-store",
          ...(error.status === 401
            ? {
                "WWW-Authenticate":
                  'Bearer realm="taxops-api", error="invalid_token"',
              }
            : {}),
        },
      },
    );
  }
  if (error instanceof FileValidationError) {
    return Response.json(
      {
        error: { code: error.code, message: error.message },
        meta: requestId ? { requestId } : undefined,
      },
      {
        status: 422,
        headers: requestId ? { "x-request-id": requestId } : undefined,
      },
    );
  }

  if (
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    if (error.status >= 500) logServerError(error, requestId, error.code);
    return Response.json(
      {
        error: {
          code: error.code,
          message:
            error.status >= 500
              ? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."
              : error.message,
        },
        meta: requestId ? { requestId } : undefined,
      },
      {
        status: error.status,
        headers: requestId ? { "x-request-id": requestId } : undefined,
      },
    );
  }

  logServerError(error, requestId);
  return Response.json(
    {
      error: { code: "INTERNAL_ERROR", message: "요청을 처리하지 못했습니다." },
      meta: requestId ? { requestId } : undefined,
    },
    {
      status: 500,
      headers: requestId ? { "x-request-id": requestId } : undefined,
    },
  );
}

export function requestIdFrom(request: Request) {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}
