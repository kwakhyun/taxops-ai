import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

const maximumClockSkewMs = 30_000;

export class ReviewServiceTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "REVIEW_SERVICE_TRANSPORT_INVALID";
  }
}

function encryptionKey(secret: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new ReviewServiceTransportError(
      "Reviewer service secret must be base64url encoded",
    );
  }
  const decoded = Buffer.from(secret, "base64url");
  if (decoded.byteLength < 32) {
    throw new ReviewServiceTransportError(
      "Reviewer service secret must contain at least 32 bytes",
    );
  }
  return createHash("sha256").update(decoded).digest();
}

export function reviewServiceContext(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  direction: "request" | "response";
  status?: number;
}) {
  return [
    "taxops-review-v1",
    input.direction,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.status?.toString() ?? "",
  ].join("\n");
}

export function createReviewServiceEnvelope(
  secret: string,
  value: unknown,
  context: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

export function openReviewServiceEnvelope(
  secret: string,
  envelopeText: string,
  context: string,
): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new ReviewServiceTransportError("Reviewer envelope is not JSON");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    (envelope as { version?: unknown }).version !== 1
  ) {
    throw new ReviewServiceTransportError(
      "Reviewer envelope version is invalid",
    );
  }
  const { iv, ciphertext, tag } = envelope as Record<string, unknown>;
  if (
    typeof iv !== "string" ||
    typeof ciphertext !== "string" ||
    typeof tag !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(iv) ||
    !/^[A-Za-z0-9_-]*$/.test(ciphertext) ||
    !/^[A-Za-z0-9_-]+$/.test(tag)
  ) {
    throw new ReviewServiceTransportError(
      "Reviewer envelope fields are invalid",
    );
  }
  try {
    const ivBytes = Buffer.from(iv, "base64url");
    const tagBytes = Buffer.from(tag, "base64url");
    if (ivBytes.byteLength !== 12 || tagBytes.byteLength !== 16) {
      throw new Error("invalid AES-GCM parameters");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      ivBytes,
    );
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tagBytes);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    throw new ReviewServiceTransportError(
      "Reviewer envelope authentication failed",
    );
  }
}

export function createReviewServiceRequestMetadata(now = Date.now()) {
  return {
    timestamp: now.toString(),
    nonce: randomUUID(),
  };
}

export function assertFreshReviewServiceRequest(
  timestamp: string,
  nonce: string,
  now = Date.now(),
) {
  if (!/^\d{13}$/.test(timestamp) || !/^[0-9a-f-]{36}$/i.test(nonce)) {
    throw new ReviewServiceTransportError(
      "Reviewer request metadata is invalid",
    );
  }
  const requestedAt = Number(timestamp);
  if (
    !Number.isSafeInteger(requestedAt) ||
    Math.abs(now - requestedAt) > maximumClockSkewMs
  ) {
    throw new ReviewServiceTransportError("Reviewer request is stale");
  }
}
