import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { NextRequest } from "next/server";
import {
  getSessionUser,
  getReviewerIdentityToken,
  issueOidcSession,
  sealReviewerAccessToken,
} from "@/lib/auth/session";
import { AuthenticationError } from "@/lib/auth/session-error";
import {
  createAuthorizationRequest,
  consumeAuthorizationTransaction,
} from "@/lib/auth/oidc-flow";
import { GET as callback } from "@/app/api/auth/callback/route";
import { GET as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { apiError } from "@/lib/http/errors";
import { authRecoveryUrl } from "@/lib/auth/recovery";
import { authStatusResponse } from "@/lib/auth/browser-response";
import { proxy } from "@/proxy";

const mocks = vi.hoisted(() => ({
  cookies: vi.fn(),
  headers: vi.fn(),
  principal: vi.fn(),
  register: vi.fn(),
  active: vi.fn(),
  revoke: vi.fn(),
  jwks: vi.fn(),
}));
vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
  headers: mocks.headers,
}));
vi.mock("@/lib/auth/principal", () => ({
  resolveOidcPrincipal: mocks.principal,
}));
vi.mock("@/lib/auth/session-store", () => ({
  registerWebSession: mocks.register,
  assertWebSessionActive: mocks.active,
  revokeWebSession: mocks.revoke,
}));
vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jose")>()),
  createRemoteJWKSet: () => mocks.jwks,
}));

const issuer = "https://identity.example.invalid";
const origin = "https://taxops.example.invalid";
const user = {
  id: "user-a",
  tenantId: "00000000-0000-4000-8000-000000000001",
  role: "REVIEWER",
  name: "검토자",
};
const cookieValues = new Map<string, string>();
let requestHeaders: Headers;
let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const keys = await generateKeyPair("ES256");
  privateKey = keys.privateKey;
  jwks = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
});

beforeEach(() => {
  vi.resetAllMocks();
  cookieValues.clear();
  requestHeaders = new Headers();
  mocks.cookies.mockImplementation(async () => ({
    get: (name: string) =>
      cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined,
  }));
  mocks.headers.mockImplementation(async () => requestHeaders);
  mocks.jwks.mockImplementation(jwks);
  mocks.principal.mockResolvedValue(user);
  mocks.active.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue(undefined);
  mocks.revoke.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("AUTH_MODE", "oidc");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SESSION_SECRET", "test-session-secret-at-least-32-characters");
  vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("OIDC_ISSUER", issuer);
  vi.stubEnv("OIDC_JWKS_URL", issuer + "/jwks");
  vi.stubEnv("OIDC_AUDIENCE", "taxops-api");
  vi.stubEnv("OIDC_CLIENT_ID", "taxops-web");
  vi.stubEnv("OIDC_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("OIDC_AUTHORIZATION_URL", issuer + "/authorize");
  vi.stubEnv("OIDC_TOKEN_URL", issuer + "/token");
  vi.stubEnv("OIDC_REVIEW_AUDIENCE", "taxops-review-api");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function token(
  claims: Record<string, unknown> = {},
  audience = "taxops-api",
  expired = false,
) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({ tenant_id: user.tenantId, auth_time: now, ...claims })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer)
    .setSubject("oidc-user")
    .setAudience(audience)
    .setIssuedAt(now - (expired ? 3_600 : 0))
    .setExpirationTime(now + (expired ? -60 : 600))
    .sign(privateKey);
}

async function authorization(reauthenticate = false) {
  const request = await createAuthorizationRequest("/reviews?matter=sample", {
    reauthenticate,
    ...(reauthenticate
      ? { expectedUser: { id: user.id, tenantId: user.tenantId } }
      : {}),
  });
  const state = request.authorizationUrl.searchParams.get("state")!;
  const transaction = await consumeAuthorizationTransaction(
    request.transaction,
    state,
  );
  const callbackRequest = (params: Record<string, string>) =>
    new Request(
      origin +
        "/api/auth/callback?" +
        new URLSearchParams({ state, ...params }),
      { headers: { cookie: "taxops_oidc_transaction=" + request.transaction } },
    );
  return { ...request, transaction, callbackRequest };
}

function location(response: Response) {
  return new URL(response.headers.get("location")!);
}
function expectTransactionCleared(response: Response) {
  expect(response.headers.get("set-cookie")).toMatch(
    /taxops_oidc_transaction=;/,
  );
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("authentication error classification", () => {
  it("keeps recovery on the public OIDC origin behind a reverse proxy", () => {
    const response = authStatusResponse(
      new Request("http://localhost:3000/api/auth/callback"),
      "cancelled",
      "origin-check",
      "/reviews",
    );
    expect(location(response).origin).toBe(origin);
    expect(location(response).pathname).toBe("/auth/status");
  });

  it("still renders an error destination when the public origin is misconfigured", () => {
    vi.stubEnv("APP_BASE_URL", "invalid-url");
    const response = authStatusResponse(
      new Request(origin + "/api/auth/login"),
      "unavailable",
      "origin-check",
    );
    expect(location(response).origin).toBe(origin);
    expect(location(response).searchParams.get("reason")).toBe("unavailable");
  });

  it.each(["review-proof", "callback", "logout"])(
    "does not disguise missing signing configuration as user error or successful revocation: %s",
    async (kind) => {
      const flow = await authorization();
      cookieValues.set(
        "taxops_session",
        await issueOidcSession({
          subject: "oidc-user",
          tenantId: user.tenantId,
        }),
      );
      cookieValues.set(
        "taxops_review_access",
        await sealReviewerAccessToken(await token()),
      );
      vi.stubEnv("SESSION_SECRET", "");
      if (kind === "review-proof") {
        await expect(getReviewerIdentityToken()).rejects.toMatchObject({
          status: 503,
          code: "AUTH_SERVICE_UNAVAILABLE",
        });
      } else if (kind === "callback") {
        const response = await callback(flow.callbackRequest({ code: "code" }));
        expect(location(response).searchParams.get("reason")).toBe(
          "unavailable",
        );
        expectTransactionCleared(response);
      } else {
        const response = await logout(
          new Request(origin + "/api/auth/logout", { method: "POST" }),
        );
        expect(location(response).searchParams.get("reason")).toBe(
          "logout-incomplete",
        );
        expect(
          response.headers
            .getSetCookie()
            .find((value) => value.startsWith("taxops_session=")),
        ).toContain("Max-Age=0");
      }
    },
  );
  it.each(["malformed", "expired", "wrong-audience", "bad-signature"])(
    "returns 401 for %s bearer credentials",
    async (kind) => {
      let value =
        kind === "malformed"
          ? "not-a-jwt"
          : await token(
              {},
              kind === "wrong-audience" ? "other-api" : "taxops-api",
              kind === "expired",
            );
      if (kind === "bad-signature") {
        const parts = value.split(".");
        parts[2] = "A".repeat(86);
        value = parts.join(".");
      }
      requestHeaders.set("authorization", "Bearer " + value);
      const error = await getSessionUser().catch((cause: unknown) => cause);
      const response = apiError(error, "auth-probe");
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_TOKEN" },
      });
      expect(response.headers.get("www-authenticate")).toContain(
        "invalid_token",
      );
      expect(mocks.principal).not.toHaveBeenCalled();
    },
  );

  it("keeps JWKS failure distinct from invalid credentials", async () => {
    requestHeaders.set("authorization", "Bearer " + (await token()));
    mocks.jwks.mockRejectedValue(
      new TypeError("fetch failed: secret=never-log"),
    );
    const response = apiError(
      await getSessionUser().catch((e: unknown) => e),
      "jwks-probe",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_SERVICE_UNAVAILABLE" },
    });
    expect(response.headers.has("www-authenticate")).toBe(false);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "never-log",
    );
  });

  it("accepts a valid bearer token and resolves its DB membership", async () => {
    requestHeaders.set("authorization", "Bearer " + (await token()));
    expect(await getSessionUser()).toEqual(user);
    expect(mocks.principal).toHaveBeenCalledWith({
      subject: "oidc-user",
      tenantClaim: user.tenantId,
    });
  });

  it("requires reauthentication for missing or damaged reviewer proof", async () => {
    await expect(getReviewerIdentityToken()).rejects.toMatchObject({
      status: 401,
      code: "REVIEW_REAUTH_REQUIRED",
    });
    cookieValues.set("taxops_review_access", "damaged");
    await expect(getReviewerIdentityToken()).rejects.toMatchObject({
      status: 401,
      code: "REVIEW_REAUTH_REQUIRED",
    });
    const valid = await token();
    cookieValues.set(
      "taxops_review_access",
      await sealReviewerAccessToken(valid),
    );
    expect(await getReviewerIdentityToken()).toBe(valid);
  });

  it("does not turn a session database outage into a login loop", async () => {
    cookieValues.set(
      "taxops_session",
      await issueOidcSession({ subject: "oidc-user", tenantId: user.tenantId }),
    );
    mocks.active.mockRejectedValue(new Error("database unavailable"));
    expect(
      apiError(await getSessionUser().catch((e: unknown) => e)).status,
    ).toBe(500);
    mocks.active.mockRejectedValue(new AuthenticationError());
    expect(
      apiError(await getSessionUser().catch((e: unknown) => e)).status,
    ).toBe(401);
  });
});

describe("OIDC browser lifecycle", () => {
  it("requests fresh login, binds the current account and preserves a safe return path", async () => {
    cookieValues.set(
      "taxops_session",
      await issueOidcSession({ subject: "oidc-user", tenantId: user.tenantId }),
    );
    const response = await login(
      new Request(
        origin + "/api/auth/login?reauthenticate=1&returnTo=%2Freviews",
      ),
    );
    const url = location(response);
    expect(url.searchParams.get("max_age")).toBe("0");
    expect(url.searchParams.get("prompt")).toBe("login");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = response.headers
      .get("set-cookie")!
      .match(/taxops_oidc_transaction=([^;]+)/)![1]!;
    const transaction = await consumeAuthorizationTransaction(
      cookie,
      url.searchParams.get("state")!,
    );
    expect(transaction).toMatchObject({
      returnTo: "/reviews",
      reauthenticate: true,
      expectedUser: { id: user.id, tenantId: user.tenantId },
    });
  });

  it("shows a retry page on cancellation and removes the one-time transaction cookie", async () => {
    const flow = await authorization(true);
    const response = await callback(
      flow.callbackRequest({
        error: "access_denied",
        error_description: "do-not-display-provider-data",
      }),
    );
    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe("/auth/status");
    expect(location(response).searchParams.get("reason")).toBe("cancelled");
    expect(location(response).searchParams.get("returnTo")).toBe(
      "/reviews?matter=sample",
    );
    expect(response.headers.get("location")).not.toContain("provider-data");
    expectTransactionCleared(response);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it.each(["invalid-state", "missing-state", "expired-transaction"])(
    "rejects %s before code exchange",
    async (kind) => {
      const flow = await authorization();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const request = flow.callbackRequest({
        code: "test-code",
        state: kind === "missing-state" ? "" : "wrong-state",
      });
      if (kind === "expired-transaction")
        vi.useFakeTimers({ now: Date.now() + 11 * 60_000 });
      try {
        const response = await callback(
          kind === "expired-transaction"
            ? flow.callbackRequest({ code: "test-code" })
            : request,
        );
        expect(location(response).searchParams.get("reason")).toBe("invalid");
        expectTransactionCleared(response);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mocks.register).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "normal",
    "reauthentication",
    "wrong-nonce",
    "stale-login",
    "different-account",
  ])("handles %s without replaying any approval", async (kind) => {
    const flow = await authorization(kind !== "normal");
    const idToken = await token(
      {
        nonce: kind === "wrong-nonce" ? "wrong" : flow.transaction.nonce,
        ...(kind === "stale-login"
          ? { auth_time: Math.floor(Date.now() / 1000) - 3600 }
          : {}),
      },
      "taxops-web",
    );
    const fetchSpy = vi.fn().mockResolvedValue(
      Response.json({
        id_token: idToken,
        access_token: await token({}, "taxops-review-api"),
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    if (kind === "different-account")
      mocks.principal.mockResolvedValue({ ...user, id: "other-user" });
    const response = await callback(
      flow.callbackRequest({ code: "test-code" }),
    );
    expectTransactionCleared(response);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(issuer + "/token");
    if (kind === "normal" || kind === "reauthentication") {
      expect(mocks.register).toHaveBeenCalledTimes(1);
      expect(response.headers.get("set-cookie")).toContain("taxops_session=");
      expect(response.headers.get("set-cookie")).toContain(
        "taxops_review_access=",
      );
      expect(location(response).pathname).toBe(
        kind === "normal" ? "/reviews" : "/auth/status",
      );
      if (kind !== "normal")
        expect(location(response).searchParams.get("reason")).toBe(
          "reauthenticated",
        );
    } else {
      expect(mocks.register).not.toHaveBeenCalled();
      expect(location(response).searchParams.get("reason")).toBe("invalid");
      expect(response.headers.get("set-cookie")).not.toContain(
        "taxops_session=",
      );
    }
  });

  it("returns a browser error page for identity service outages", async () => {
    const flow = await authorization();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network unavailable")),
    );
    const response = await callback(flow.callbackRequest({ code: "code" }));
    expect(location(response).searchParams.get("reason")).toBe("unavailable");
    expectTransactionCleared(response);
  });

  it.each([false, true])(
    "clears every browser credential even if server revocation fails: %s",
    async (failed) => {
      cookieValues.set(
        "taxops_session",
        await issueOidcSession({
          subject: "oidc-user",
          tenantId: user.tenantId,
        }),
      );
      cookieValues.set("taxops_demo_user", "admin");
      if (failed)
        mocks.revoke.mockRejectedValue(new Error("private database details"));
      const response = await logout(
        new Request(origin + "/api/auth/logout", { method: "POST" }),
      );
      expect(response.status).toBe(303);
      expect(location(response).pathname).toBe("/auth/status");
      expect(location(response).searchParams.get("reason")).toBe(
        failed ? "logout-incomplete" : "signed-out",
      );
      for (const name of [
        "taxops_session",
        "taxops_review_access",
        "taxops_demo_user",
        "taxops_oidc_transaction",
      ]) {
        expect(
          response.headers
            .getSetCookie()
            .find((value) => value.startsWith(name + "=")),
        ).toContain("Max-Age=0");
      }
      expect(mocks.revoke).toHaveBeenCalledWith(
        expect.objectContaining({
          oidcSubject: "oidc-user",
          tenantId: user.tenantId,
        }),
      );
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
        "private database details",
      );
    },
  );

  it("keeps only the status page public and rejects forged navigation context", () => {
    expect(
      proxy(
        new NextRequest(origin + "/auth/status?reason=signed-out"),
      ).headers.has("location"),
    ).toBe(false);
    expect(
      proxy(new NextRequest(origin + "/reviews")).headers.get("location"),
    ).toContain("/api/auth/login");
    expect(
      proxy(new NextRequest(origin + "/auth/status/other")).headers.get(
        "location",
      ),
    ).toContain("/api/auth/login");
    const response = proxy(
      new NextRequest(origin + "/reviews", {
        headers: {
          cookie: "taxops_session=test",
          "x-taxops-return-to": "https://evil.example",
        },
      }),
    );
    expect(
      response.headers.get("x-middleware-request-x-taxops-return-to"),
    ).toBe("/reviews");
  });

  it("offers recovery only for 401 and never permits an external return URL", () => {
    expect(authRecoveryUrl(403, "/reviews")).toBeUndefined();
    expect(authRecoveryUrl(503, "/reviews")).toBeUndefined();
    expect(authRecoveryUrl(401, "//evil.example")).toBe(
      "/api/auth/login?returnTo=%2F&reauthenticate=1",
    );
  });
});
