import { describe, expect, it } from "vitest";
import {
  assertFreshReviewServiceRequest,
  createReviewServiceEnvelope,
  openReviewServiceEnvelope,
  reviewServiceContext,
} from "@/lib/review/service-crypto";

const secret = Buffer.from("review-service-contract-secret-32-bytes!").toString(
  "base64url",
);
const context = reviewServiceContext({
  method: "POST",
  path: "/v1/decisions/workpapers",
  timestamp: "1777777777000",
  nonce: "00000000-0000-4000-8000-000000000001",
  direction: "request",
});

describe("review service encrypted transport", () => {
  it("round-trips an authenticated payload", () => {
    const envelope = createReviewServiceEnvelope(
      secret,
      { artifactHash: "a".repeat(64), decision: "APPROVED" },
      context,
    );
    expect(openReviewServiceEnvelope(secret, envelope, context)).toEqual({
      artifactHash: "a".repeat(64),
      decision: "APPROVED",
    });
    expect(envelope).not.toContain("APPROVED");
    expect(envelope).not.toContain("artifactHash");
  });

  it("rejects tampering, context substitution, weak keys and stale requests", () => {
    const envelope = createReviewServiceEnvelope(secret, { ok: true }, context);
    expect(() =>
      openReviewServiceEnvelope(secret, envelope, `${context}\nchanged`),
    ).toThrow(/authentication failed/);
    expect(() =>
      createReviewServiceEnvelope("d2Vhaw", { ok: true }, context),
    ).toThrow(/at least 32 bytes/);
    expect(() =>
      assertFreshReviewServiceRequest(
        "1777777777000",
        "00000000-0000-4000-8000-000000000001",
        1777777810001,
      ),
    ).toThrow(/stale/);
  });
});
