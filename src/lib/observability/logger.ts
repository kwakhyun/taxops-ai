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
