import "server-only";

import { z } from "zod";
import type { SessionUser } from "@/lib/domain/types";
import { getReviewerIdentityToken } from "@/lib/auth/session";
import {
  createReviewServiceEnvelope,
  createReviewServiceRequestMetadata,
  openReviewServiceEnvelope,
  reviewServiceContext,
} from "@/lib/review/service-crypto";

const workpaperResponseSchema = z.strictObject({
  ok: z.literal(true),
  decision: z.enum(["APPROVED", "REJECTED"]),
  reviewer: z.string().min(1).max(120),
  note: z.string().max(2_000),
});

const evidenceResponseSchema = z.strictObject({
  ok: z.literal(true),
  documentId: z.uuid(),
});

const approvalTokensResponseSchema = z.strictObject({
  ok: z.literal(true),
  tokens: z.strictObject({
    APPROVED: z.string().min(20),
    REJECTED: z.string().min(20),
  }),
  expiresInSeconds: z.number().int().positive().max(300),
});

class ReviewServiceError extends Error {
  readonly status = 503;
  readonly code = "REVIEW_SERVICE_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "REVIEW_SERVICE_UNAVAILABLE";
  }
}

function reviewServiceConfiguration() {
  const rawUrl = process.env.REVIEW_SERVICE_URL;
  const allowedHost = process.env.REVIEW_SERVICE_ALLOWED_HOST;
  const secret = process.env.REVIEW_SERVICE_SHARED_SECRET;
  if (!rawUrl || !allowedHost || !secret) {
    throw new ReviewServiceError("Reviewer service is not configured");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ReviewServiceError("Reviewer service URL is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== allowedHost ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ReviewServiceError("Reviewer service endpoint is not allowed");
  }
  if (
    process.env.NODE_ENV === "production" &&
    url.protocol !== "https:" &&
    process.env.REVIEW_SERVICE_ALLOW_ENCRYPTED_HTTP !== "true"
  ) {
    throw new ReviewServiceError(
      "Production reviewer service must use HTTPS or the encrypted private service endpoint",
    );
  }
  return { url, secret };
}

async function invokeReviewService<T>(
  path: string,
  payload: unknown,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const { url, secret } = reviewServiceConfiguration();
  const endpoint = new URL(path, url);
  const metadata = createReviewServiceRequestMetadata();
  const requestContext = reviewServiceContext({
    method: "POST",
    path,
    ...metadata,
    direction: "request",
  });
  const body = createReviewServiceEnvelope(secret, payload, requestContext);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/vnd.taxops.encrypted+json",
        "x-taxops-timestamp": metadata.timestamp,
        "x-taxops-nonce": metadata.nonce,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ReviewServiceError("Reviewer service request failed");
  }
  const encryptedResponse = await response.text();
  if (encryptedResponse.length > 64_000) {
    throw new ReviewServiceError("Reviewer service response is too large");
  }
  const responseContext = reviewServiceContext({
    method: "POST",
    path,
    ...metadata,
    direction: "response",
    status: response.status,
  });
  let opened: unknown;
  try {
    opened = openReviewServiceEnvelope(
      secret,
      encryptedResponse,
      responseContext,
    );
  } catch {
    throw new ReviewServiceError("Reviewer service response is not authentic");
  }
  if (response.status === 409) return undefined;
  if (!response.ok) {
    throw new ReviewServiceError("Reviewer service rejected the request");
  }
  const parsed = schema.safeParse(opened);
  if (!parsed.success) {
    throw new ReviewServiceError("Reviewer service response contract failed");
  }
  return parsed.data;
}

function actor(user: SessionUser) {
  return {
    tenantId: user.tenantId,
    id: user.id,
    name: user.name,
  };
}

export function reviewServiceIsConfigured() {
  return Boolean(process.env.REVIEW_SERVICE_URL);
}

export async function reviewServiceIsReachable() {
  try {
    const { url } = reviewServiceConfiguration();
    const response = await fetch(new URL("/health", url), {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function decideWorkpaperViaReviewService(
  user: SessionUser,
  targetId: string,
  input: {
    decision: "APPROVED" | "REJECTED";
    note: string;
    artifactHash: string;
    traceId: string;
    approvalToken: string;
  },
) {
  const identityToken = await getReviewerIdentityToken();
  return invokeReviewService(
    "/v1/decisions/workpapers",
    { identityToken, expectedActor: actor(user), targetId, ...input },
    workpaperResponseSchema,
  );
}

export async function issueWorkpaperApprovalTokensViaReviewService(
  user: SessionUser,
  targetId: string,
  artifactHash: string,
) {
  const identityToken = await getReviewerIdentityToken();
  return invokeReviewService(
    "/v1/tokens/workpapers",
    { identityToken, expectedActor: actor(user), targetId, artifactHash },
    approvalTokensResponseSchema,
  );
}

export async function decideEvidenceViaReviewService(
  user: SessionUser,
  documentId: string,
  input: {
    decision: "APPROVED" | "REJECTED";
    checksumSha256: string;
    manifestSha256: string;
    traceId: string;
  },
) {
  const identityToken = await getReviewerIdentityToken();
  return invokeReviewService(
    "/v1/decisions/evidence",
    { identityToken, expectedActor: actor(user), documentId, ...input },
    evidenceResponseSchema,
  );
}
