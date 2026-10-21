import "server-only";

import { safeMetadata } from "@/lib/security/redaction";

type LogLevel = "info" | "warn" | "error";

const allowedKeys = new Set([
  "requestId",
  "traceId",
  "tenantId",
  "actorId",
  "action",
  "targetType",
  "targetId",
  "outcome",
  "latencyMs",
  "statusCode",
  "jobId",
  "workflowId",
  "model",
  "promptVersion",
  "tokens",
  "estimatedCostKrw",
  "errorCode",
  "errorType",
]);

export function writeLog(
  level: LogLevel,
  event: string,
  metadata: Record<string, unknown> = {},
) {
  const allowlisted = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => allowedKeys.has(key)),
  );
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeMetadata(allowlisted),
  };

  const serialized = JSON.stringify(payload);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.info(serialized);
}

export function createTraceId(prefix = "tr") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function logServerError(
  error: unknown,
  requestId?: string,
  code = "INTERNAL_ERROR",
  event = "http.request_failed",
) {
  const safeTypes = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "PostgresError",
    "TimeoutError",
    "AbortError",
    "AuthenticationServiceError",
  ]);
  writeLog("error", event, {
    requestId,
    statusCode:
      typeof error === "object" &&
      error &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500,
    errorCode: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "INTERNAL_ERROR",
    errorType:
      error instanceof Error && safeTypes.has(error.name)
        ? error.name
        : "UnknownError",
    outcome: "FAILED",
  });
}
