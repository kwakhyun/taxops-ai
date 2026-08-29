import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertFreshReviewServiceRequest,
  createReviewServiceEnvelope,
  reviewServiceContext,
} from "../lib/review/service-crypto.ts";

export type RequestMetadata = {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
};

const usedNonces = new Map<string, number>();

export function logReviewEvent(
  event: string,
  fields: Record<string, unknown> = {},
) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "reviewer",
      event,
      ...fields,
    }),
  );
}

export function writeEncryptedResponse(
  target: ServerResponse,
  status: number,
  value: unknown,
  metadata: RequestMetadata,
  sharedSecret: string,
) {
  const context = reviewServiceContext({
    ...metadata,
    direction: "response",
    status,
  });
  const body = createReviewServiceEnvelope(sharedSecret, value, context);
  target.writeHead(status, {
    "content-type": "application/vnd.taxops.encrypted+json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  target.end(body);
}

export async function readRequestBody(request: IncomingMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength > 64_000) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > 64_000) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function requestMetadata(request: IncomingMessage, path: string) {
  const timestamp = request.headers["x-taxops-timestamp"];
  const nonce = request.headers["x-taxops-nonce"];
  if (typeof timestamp !== "string" || typeof nonce !== "string") {
    throw new Error("REQUEST_METADATA_MISSING");
  }
  assertFreshReviewServiceRequest(timestamp, nonce);
  const expiresAt = usedNonces.get(nonce);
  if (expiresAt && expiresAt > Date.now()) throw new Error("REQUEST_REPLAYED");
  const now = Date.now();
  for (const [candidate, expiry] of usedNonces) {
    if (expiry <= now) usedNonces.delete(candidate);
  }
  usedNonces.set(nonce, now + 60_000);
  return { method: request.method ?? "POST", path, timestamp, nonce };
}
