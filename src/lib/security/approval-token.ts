import { createHmac, timingSafeEqual } from "node:crypto";

interface ApprovalPayload {
  actorId: string;
  targetId: string;
  artifactHash: string;
  decision: "APPROVED" | "REJECTED";
  nonce: string;
  expiresAt: number;
}

const developmentSecret = crypto.randomUUID();

export function isValidApprovalTokenSecret(secret: string | undefined) {
  if (!secret || !/^[A-Za-z0-9_-]+$/.test(secret)) return false;
  const decoded = Buffer.from(secret, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === secret;
}

function key() {
  const secret = process.env.APPROVAL_TOKEN_SECRET;
  if (secret) {
    if (!isValidApprovalTokenSecret(secret)) {
      throw new Error(
        "APPROVAL_TOKEN_SECRET must be base64url-encoded 256-bit key material",
      );
    }
    return Buffer.from(secret, "base64url");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "APPROVAL_TOKEN_SECRET is required in production and must contain base64url-encoded 256-bit key material",
    );
  }
  return developmentSecret;
}

function sign(encodedPayload: string) {
  return createHmac("sha256", key()).update(encodedPayload).digest("base64url");
}

export function issueApprovalToken(
  input: Omit<ApprovalPayload, "nonce" | "expiresAt">,
) {
  const payload: ApprovalPayload = {
    ...input,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + 5 * 60_000,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export class InvalidApprovalTokenError extends Error {
  readonly status = 409;
  readonly code = "INVALID_APPROVAL_TOKEN";

  constructor(message: string) {
    super(message);
    this.name = "InvalidApprovalTokenError";
  }
}

export function verifyApprovalToken(
  token: string,
  expected: Pick<
    ApprovalPayload,
    "actorId" | "targetId" | "artifactHash" | "decision"
  >,
) {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature)
    throw new InvalidApprovalTokenError("Malformed approval token");
  const expectedSignature = sign(encoded);
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expectedSignature);
  if (
    received.length !== calculated.length ||
    !timingSafeEqual(received, calculated)
  ) {
    throw new InvalidApprovalTokenError("Approval token signature is invalid");
  }

  let payload: ApprovalPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as ApprovalPayload;
  } catch {
    throw new InvalidApprovalTokenError("Approval token payload is invalid");
  }
  if (payload.expiresAt <= Date.now())
    throw new InvalidApprovalTokenError("Approval token expired");
  if (
    payload.actorId !== expected.actorId ||
    payload.targetId !== expected.targetId ||
    payload.artifactHash !== expected.artifactHash ||
    payload.decision !== expected.decision
  ) {
    throw new InvalidApprovalTokenError(
      "Approval token is bound to a different action",
    );
  }
  return payload;
}
