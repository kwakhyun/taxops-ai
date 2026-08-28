import { ZodError } from "zod";
import { AuthenticationError } from "@/lib/auth/session";
import { AuthorizationError } from "@/lib/auth/rbac";
import { FileValidationError } from "@/lib/files/validation";
import { writeLog } from "@/lib/observability/logger";

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
      errorCode: error.name,
      outcome: "DENIED",
    });
    return Response.json(
      {
        error: { code: error.name, message: error.message },
        meta: requestId ? { requestId } : undefined,
      },
      {
        status: error.status,
        headers: requestId ? { "x-request-id": requestId } : undefined,
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
    return Response.json(
      {
        error: { code: error.code, message: error.message },
        meta: requestId ? { requestId } : undefined,
      },
      {
        status: error.status,
        headers: requestId ? { "x-request-id": requestId } : undefined,
      },
    );
  }

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
