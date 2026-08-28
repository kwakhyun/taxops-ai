import { createHash } from "node:crypto";

export interface AuditPayload {
  tenantId: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "SUCCESS" | "DENIED" | "FAILED";
  occurredAt: string;
  traceId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

function canonicalize(payload: AuditPayload) {
  const metadata = Object.fromEntries(
    Object.entries(payload.metadata ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  return [
    payload.tenantId,
    payload.actorId,
    payload.action,
    payload.targetType,
    payload.targetId,
    payload.outcome,
    payload.occurredAt,
    payload.traceId,
    JSON.stringify(metadata),
  ].join("\u001f");
}

export function hashAuditEvent(previousHash: string, payload: AuditPayload) {
  return createHash("sha256")
    .update(`${previousHash}\u001f${canonicalize(payload)}`)
    .digest("hex");
}

export function verifyAuditChain(
  events: Array<AuditPayload & { previousHash: string; hash: string }>,
) {
  if (events.length === 0) return false;

  const hashesAreValid = events.every((event) => {
    const { previousHash, hash, ...payload } = event;
    return hash === hashAuditEvent(previousHash, payload);
  });
  if (!hashesAreValid) return false;

  // Repository queries return newest first. Every newer entry must point to
  // the hash of the immediately older entry in the returned interval.
  const linksAreValid = events
    .slice(0, -1)
    .every((event, index) => event.previousHash === events[index + 1]!.hash);
  const oldestEvent = events.at(-1)!;
  return linksAreValid && oldestEvent.previousHash === "0".repeat(64);
}
