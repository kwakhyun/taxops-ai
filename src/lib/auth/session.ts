import "server-only";

import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import {
  compactDecrypt,
  CompactEncrypt,
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  type JWTPayload,
} from "jose";
import { resolveOidcPrincipal } from "@/lib/auth/principal";
import { AuthenticationError } from "@/lib/auth/session-error";
import { resolveAuthMode } from "@/lib/auth/auth-mode";
import { demoUsers } from "@/lib/domain/fixtures";
import type { SessionUser } from "@/lib/domain/types";
import {
  providerJwtValidationOptions,
  webSessionValidationOptions,
} from "@/lib/auth/token-policy";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";
import {
  assertWebSessionActive,
  registerWebSession,
  revokeWebSession,
} from "@/lib/auth/session-store";

const DEMO_COOKIE = "taxops_demo_user";
const OIDC_SESSION_COOKIE = "taxops_session";
const OIDC_REVIEW_ACCESS_COOKIE = "taxops_review_access";
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export { AuthenticationError } from "@/lib/auth/session-error";

function sessionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new AuthenticationError(
      "SESSION_SECRET must contain at least 32 characters",
    );
  }
  return new TextEncoder().encode(secret);
}

function identityEncryptionKey() {
  return createHash("sha256").update(sessionKey()).digest();
}

export async function sealReviewerAccessToken(token: string) {
  return new CompactEncrypt(new TextEncoder().encode(token))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT+JWE" })
    .encrypt(identityEncryptionKey());
}

async function openProviderIdentityToken(encrypted: string) {
  try {
    const { plaintext, protectedHeader } = await compactDecrypt(
      encrypted,
      identityEncryptionKey(),
      {
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      },
    );
    if (protectedHeader.typ !== "JWT+JWE") throw new Error("invalid type");
    const token = new TextDecoder().decode(plaintext);
    if (token.split(".").length !== 3) throw new Error("invalid token");
    return token;
  } catch {
    throw new AuthenticationError("OIDC identity proof is invalid");
  }
}

export async function verifyProviderToken(token: string, audience: string) {
  const issuer = process.env.OIDC_ISSUER;
  const jwksUrl = process.env.OIDC_JWKS_URL;
  if (!issuer) throw new AuthenticationError("OIDC issuer is not configured");

  const resolvedJwksUrl =
    jwksUrl ?? `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  let jwks = jwksByUrl.get(resolvedJwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(resolvedJwksUrl));
    jwksByUrl.set(resolvedJwksUrl, jwks);
  }
  const { payload } = await jwtVerify(
    token,
    jwks,
    providerJwtValidationOptions(issuer, audience),
  );

  return payload;
}

export async function issueOidcSession(input: {
  subject: string;
  tenantId: string;
}) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1_000);
  const token = await new SignJWT({ tenant_id: input.tenantId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.subject)
    .setIssuer("taxops-ai")
    .setAudience("taxops-web")
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
    .setJti(id)
    .sign(sessionKey());
  await registerWebSession({
    id,
    tenantId: input.tenantId,
    oidcSubject: input.subject,
    expiresAt,
  });
  return token;
}

function webSessionBinding(payload: {
  sub?: string;
  jti?: string;
  tenant_id?: unknown;
}) {
  if (
    typeof payload.sub !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.tenant_id !== "string"
  ) {
    throw new AuthenticationError("OIDC session claims are incomplete");
  }
  return {
    id: payload.jti,
    tenantId: payload.tenant_id,
    oidcSubject: payload.sub,
  };
}

export async function validateOidcSessionToken(token: string) {
  const { payload } = await jwtVerify(
    token,
    sessionKey(),
    webSessionValidationOptions,
  );
  await assertWebSessionActive(webSessionBinding(payload));
  return payload;
}

export async function revokeOidcSession(token: string) {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(
      token,
      sessionKey(),
      webSessionValidationOptions,
    ));
  } catch {
    return;
  }
  await revokeWebSession(webSessionBinding(payload));
}

async function principalFromClaims(payload: {
  sub?: string;
  tenant_id?: unknown;
}) {
  if (
    typeof payload.sub !== "string" ||
    typeof payload.tenant_id !== "string"
  ) {
    throw new AuthenticationError("OIDC claims are incomplete");
  }
  return resolveOidcPrincipal({
    subject: payload.sub,
    tenantClaim: payload.tenant_id,
  });
}

async function getOidcSession(): Promise<SessionUser> {
  const headerStore = await headers();
  const authorization = headerStore.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const audience = process.env.OIDC_AUDIENCE;
    if (!audience) throw new AuthenticationError("OIDC audience is missing");
    return principalFromClaims(
      await verifyProviderToken(authorization.slice(7), audience),
    );
  }

  const cookieStore = await cookies();
  const session = cookieStore.get(OIDC_SESSION_COOKIE)?.value;
  if (!session) {
    throw new AuthenticationError("A valid OIDC session is required");
  }
  try {
    const payload = await validateOidcSessionToken(session);
    return principalFromClaims(payload);
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("OIDC session is invalid or expired");
  }
}

export const getSessionUser = cache(async (): Promise<SessionUser> => {
  const authMode = resolveAuthMode(
    process.env.AUTH_MODE,
    process.env.NODE_ENV,
    isPortfolioDemo(),
  );

  if (authMode === "oidc") return getOidcSession();

  const cookieStore = await cookies();
  const requestedDemoUser = cookieStore.get(DEMO_COOKIE)?.value ?? "analyst";
  return demoUsers[requestedDemoUser] ?? demoUsers.analyst!;
});

export async function getReviewerIdentityToken() {
  const headerStore = await headers();
  const authorization = headerStore.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);

  const cookieStore = await cookies();
  const encrypted = cookieStore.get(OIDC_REVIEW_ACCESS_COOKIE)?.value;
  if (!encrypted) {
    throw new AuthenticationError(
      "A fresh OIDC identity proof is required for reviewer decisions",
    );
  }
  return openProviderIdentityToken(encrypted);
}

export const demoAuthCookie = DEMO_COOKIE;
export const oidcSessionCookie = OIDC_SESSION_COOKIE;
export const oidcReviewAccessCookie = OIDC_REVIEW_ACCESS_COOKIE;
