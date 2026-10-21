import { NextResponse } from "next/server";
import {
  appBaseUrl,
  consumeAuthorizationTransaction,
  exchangeAuthorizationCode,
  oidcClientId,
  oidcTransactionCookie,
} from "@/lib/auth/oidc-flow";
import {
  issueOidcSession,
  oidcReviewAccessCookie,
  oidcSessionCookie,
  sealReviewerAccessToken,
  verifyProviderToken,
} from "@/lib/auth/session";
import { resolveOidcPrincipal } from "@/lib/auth/principal";
import { AuthenticationError } from "@/lib/auth/session-error";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import {
  authStatusResponse,
  clearAuthTransaction,
} from "@/lib/auth/browser-response";
import { writeLog } from "@/lib/observability/logger";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  let returnTo = "/";
  let reauthenticate = false;
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const transactionCookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${oidcTransactionCookie}=`))
      ?.slice(oidcTransactionCookie.length + 1);
    if (!state || !transactionCookie) {
      throw new AuthenticationError("OIDC callback parameters are incomplete");
    }
    const transaction = await consumeAuthorizationTransaction(
      decodeURIComponent(transactionCookie),
      state,
    );
    returnTo = transaction.returnTo;
    reauthenticate = transaction.reauthenticate;
    const providerError = url.searchParams.get("error");
    if (providerError) {
      writeLog("warn", "auth.login_failed", {
        requestId,
        errorCode:
          providerError === "access_denied"
            ? "LOGIN_CANCELLED"
            : "PROVIDER_REJECTED",
        outcome: "DENIED",
      });
      return authStatusResponse(
        request,
        providerError === "access_denied" ? "cancelled" : "invalid",
        requestId,
        returnTo,
        reauthenticate,
      );
    }
    if (!code)
      throw new AuthenticationError("OIDC authorization code is missing");
    const tokens = await exchangeAuthorizationCode(code, transaction.verifier);
    const claims = await verifyProviderToken(tokens.id_token, oidcClientId());
    if (claims.nonce !== transaction.nonce) {
      throw new AuthenticationError("OIDC nonce validation failed");
    }
    if (
      typeof claims.auth_time !== "number" ||
      !Number.isFinite(claims.auth_time) ||
      claims.auth_time < transaction.iat - 30 ||
      claims.auth_time > Date.now() / 1_000 + 30
    ) {
      throw new AuthenticationError("Fresh OIDC authentication is required");
    }
    if (
      typeof claims.sub !== "string" ||
      typeof claims.tenant_id !== "string"
    ) {
      throw new AuthenticationError("OIDC identity claims are incomplete");
    }
    const principal = await resolveOidcPrincipal({
      subject: claims.sub,
      tenantClaim: claims.tenant_id,
    });
    if (
      transaction.expectedUser &&
      (transaction.expectedUser.id !== principal.id ||
        transaction.expectedUser.tenantId !== principal.tenantId)
    ) {
      throw new AuthenticationError(
        "Reauthentication must use the same account and tenant",
      );
    }
    const encryptedReviewToken = await sealReviewerAccessToken(
      tokens.access_token,
    );
    const session = await issueOidcSession({
      subject: claims.sub,
      tenantId: claims.tenant_id,
    });
    const response = reauthenticate
      ? authStatusResponse(request, "reauthenticated", requestId, returnTo)
      : clearAuthTransaction(
          NextResponse.redirect(new URL(returnTo, appBaseUrl())),
        );
    response.cookies.set(oidcSessionCookie, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60,
      path: "/",
    });
    response.cookies.set(oidcReviewAccessCookie, encryptedReviewToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: 15 * 60,
      path: "/",
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    const failure = apiError(error, requestId);
    return authStatusResponse(
      request,
      failure.status >= 500 ? "unavailable" : "invalid",
      requestId,
      returnTo,
      reauthenticate,
    );
  }
}
