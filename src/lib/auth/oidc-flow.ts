import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { AuthenticationError } from "@/lib/auth/session-error";
import { safeReturnTo } from "@/lib/auth/return-to";
import { fetchWithoutRedirect } from "@/lib/security/safe-fetch";

export const oidcTransactionCookie = "taxops_oidc_transaction";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new AuthenticationError(`${name} is not configured`);
  return value;
}

function signingKey() {
  const secret = required("SESSION_SECRET");
  if (secret.length < 32) {
    throw new AuthenticationError(
      "SESSION_SECRET must contain at least 32 characters",
    );
  }
  return new TextEncoder().encode(secret);
}

function configuredUrl(name: string) {
  const url = new URL(required(name));
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new AuthenticationError(`${name} must use HTTPS`);
  }
  return url;
}

export function appBaseUrl() {
  return configuredUrl("APP_BASE_URL");
}

export function oidcRedirectUri() {
  return new URL("/api/auth/callback", appBaseUrl()).toString();
}

export async function createAuthorizationRequest(returnTo: string | null) {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const transaction = await new SignJWT({
    state,
    nonce,
    verifier,
    returnTo: safeReturnTo(returnTo),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("taxops-ai")
    .setAudience("oidc-transaction")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey());

  const authorizationUrl = configuredUrl("OIDC_AUTHORIZATION_URL");
  const authorizationParameters: Record<string, string> = {
    response_type: "code",
    client_id: required("OIDC_CLIENT_ID"),
    redirect_uri: oidcRedirectUri(),
    scope: `openid profile email ${process.env.OIDC_REVIEW_SCOPE ?? "review:decide"}`,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const reviewAudience = required("OIDC_REVIEW_AUDIENCE");
  const reviewResourceParameter =
    process.env.OIDC_REVIEW_RESOURCE_PARAMETER ?? "resource";
  if (!new Set(["resource", "audience"]).has(reviewResourceParameter)) {
    throw new AuthenticationError(
      "OIDC_REVIEW_RESOURCE_PARAMETER must be resource or audience",
    );
  }
  authorizationParameters[reviewResourceParameter] = reviewAudience;
  if (process.env.OIDC_REVIEW_REQUIRED_ACR) {
    authorizationParameters.acr_values = process.env.OIDC_REVIEW_REQUIRED_ACR;
  }
  authorizationUrl.search = new URLSearchParams(
    authorizationParameters,
  ).toString();
  return { authorizationUrl, transaction };
}

const transactionSchema = z.object({
  state: z.string().min(32),
  nonce: z.string().min(32),
  verifier: z.string().min(43),
  returnTo: z.string().startsWith("/"),
});

export async function consumeAuthorizationTransaction(
  token: string,
  returnedState: string,
) {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: "taxops-ai",
      audience: "oidc-transaction",
      algorithms: ["HS256"],
    });
    const transaction = transactionSchema.parse(payload);
    if (transaction.state !== returnedState) {
      throw new AuthenticationError("OIDC state validation failed");
    }
    return transaction;
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("OIDC transaction is invalid or expired");
  }
}

const tokenResponseSchema = z.object({
  id_token: z.string().min(20),
  access_token: z.string().min(20),
  token_type: z.string().optional(),
});

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
) {
  const clientId = required("OIDC_CLIENT_ID");
  const clientSecret = required("OIDC_CLIENT_SECRET");
  const response = await fetchWithoutRedirect(configuredUrl("OIDC_TOKEN_URL"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidcRedirectUri(),
      client_id: clientId,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new AuthenticationError("OIDC authorization code exchange failed");
  }
  return tokenResponseSchema.parse(await response.json());
}

export function oidcClientId() {
  return required("OIDC_CLIENT_ID");
}
