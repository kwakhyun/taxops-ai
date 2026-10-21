import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { verifyReviewerIdentity } from "@/reviewer/identity";
import { createReviewerHttpServer } from "@/reviewer/http-server";
import { issueWorkpaperApprovalTokensViaReviewService } from "@/lib/review/service-client";
import { demoUsers } from "@/lib/domain/fixtures";
import { readFileSync } from "node:fs";
import {
  createReviewServiceEnvelope,
  openReviewServiceEnvelope,
} from "@/lib/review/service-crypto";

const mocks = vi.hoisted(() => ({ proof: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getReviewerIdentityToken: mocks.proof,
}));

const secret = Buffer.from("review-recovery-test-32-byte-secret!").toString(
  "base64url",
);
const user = {
  ...demoUsers.reviewer!,
  id: "00000000-0000-4000-8000-000000000102",
  tenantId: "00000000-0000-4000-8000-000000000001",
};
const config = {
  issuer: "https://identity.invalid",
  audience: "review-api",
  scope: "review:decide",
  acr: "mfa",
  clientId: "web",
};
let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;
let actualStatus: number;

beforeAll(async () => {
  const keys = await generateKeyPair("ES256");
  privateKey = keys.privateKey;
  jwks = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
});
beforeEach(() => {
  vi.stubEnv("REVIEW_SERVICE_URL", "http://reviewer.test:3100");
  vi.stubEnv("REVIEW_SERVICE_ALLOWED_HOST", "reviewer.test");
  vi.stubEnv("REVIEW_SERVICE_SHARED_SECRET", secret);
  vi.stubEnv("NODE_ENV", "test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  actualStatus = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function proof(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tenant_id: user.tenantId,
    scope: config.scope,
    acr: config.acr,
    auth_time: now,
    azp: config.clientId,
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject("reviewer")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

// Exercise the real HTTP listener and encrypted client contract without sockets,
// a database, Docker, or a browser process.
function connectTransport(key: JWTVerifyGetKey = jwks) {
  const handler = async (input: {
    identityToken: string;
    expectedActor: { tenantId: string };
  }) => {
    await verifyReviewerIdentity(
      input.identityToken,
      input.expectedActor.tenantId,
      key,
      config,
    );
    return {
      ok: true,
      tokens: { APPROVED: "a".repeat(32), REJECTED: "b".repeat(32) },
      expiresInSeconds: 300,
    };
  };
  const server = createReviewerHttpServer({
    sharedSecret: secret,
    healthCheck: async () => {},
    issueWorkpaperTokens: handler,
    decideWorkpaper: handler,
    decideEvidence: handler,
  });
  const listener = server.listeners("request")[0]!;
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    const request = Object.assign(
      Readable.from([Buffer.from(init.body as string)]),
      {
        method: "POST",
        url: url.pathname,
        headers: Object.fromEntries(new Headers(init.headers)),
      },
    );
    let responseHeaders: HeadersInit = {};
    let body = "";
    const response = {
      writeHead(status: number, headers: HeadersInit) {
        actualStatus = status;
        responseHeaders = headers;
      },
      end(value: string) {
        body = value;
      },
    };
    await listener(
      request as unknown as IncomingMessage,
      response as unknown as ServerResponse,
    );
    return new Response(body, {
      status: actualStatus,
      headers: responseHeaders,
    });
  });
}

const issueTokens = () =>
  issueWorkpaperApprovalTokensViaReviewService(
    user,
    "00000000-0000-4000-8000-000000000401",
    "a".repeat(64),
  );

describe("reviewer identity recovery across encrypted service boundary", () => {
  it("returns reauthentication-required after fifteen minutes, then accepts a renewed proof", async () => {
    connectTransport();
    mocks.proof.mockResolvedValue(
      await proof({ auth_time: Math.floor(Date.now() / 1000) - 901 }),
    );
    await expect(issueTokens()).rejects.toMatchObject({
      status: 401,
      code: "REVIEW_REAUTH_REQUIRED",
    });
    expect(actualStatus).toBe(401);
    mocks.proof.mockResolvedValue(await proof());
    await expect(issueTokens()).resolves.toMatchObject({
      ok: true,
      expiresInSeconds: 300,
    });
    expect(actualStatus).toBe(200);
  });

  it.each([
    { scope: "openid" },
    { acr: "password" },
    { azp: "other-client" },
    { tenant_id: "another-tenant" },
  ])(
    "keeps authorization failure distinct from expiration: %j",
    async (claims) => {
      connectTransport();
      mocks.proof.mockResolvedValue(await proof(claims));
      await expect(issueTokens()).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
      expect(actualStatus).toBe(403);
    },
  );

  it("does not prompt reauthentication for a provider outage", async () => {
    connectTransport(async () => {
      throw new TypeError("JWKS unavailable");
    });
    mocks.proof.mockResolvedValue(await proof());
    await expect(issueTokens()).rejects.toMatchObject({
      status: 503,
      code: "REVIEW_SERVICE_UNAVAILABLE",
    });
    expect(actualStatus).toBe(503);
  });

  it("does not trust an unencrypted forged 401 response", async () => {
    mocks.proof.mockResolvedValue(await proof());
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ code: "REVIEW_REAUTH_REQUIRED" }, { status: 401 }),
        ),
    );
    await expect(issueTokens()).rejects.toMatchObject({
      status: 503,
      code: "REVIEW_SERVICE_UNAVAILABLE",
    });
  });
});

describe("Compose shared reviewer secret", () => {
  it("defines the default once and round-trips an encrypted service request", () => {
    const compose = readFileSync(
      new URL("../compose.yaml", import.meta.url),
      "utf8",
    );
    const reviewer = compose.split("\n  reviewer:")[1]!.split("\n  web:")[0]!;
    const web = compose.split("\n  web:")[1]!;
    const match = reviewer.match(
      /REVIEW_SERVICE_SHARED_SECRET: &review-service-secret \$\{REVIEW_SERVICE_SHARED_SECRET:-([^}]+)\}/,
    );
    expect(match).not.toBeNull();
    expect(web).toContain(
      "REVIEW_SERVICE_SHARED_SECRET: *review-service-secret",
    );
    expect(compose.match(/\$\{REVIEW_SERVICE_SHARED_SECRET:/g)).toHaveLength(1);
    const sharedDefault = match![1]!;
    const encrypted = createReviewServiceEnvelope(
      sharedDefault,
      { test: "payload" },
      "compose-contract",
    );
    expect(
      openReviewServiceEnvelope(sharedDefault, encrypted, "compose-contract"),
    ).toEqual({ test: "payload" });
  });
});
