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

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
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
    if (!code || !state || !transactionCookie) {
      throw new AuthenticationError("OIDC callback parameters are incomplete");
    }
    const transaction = await consumeAuthorizationTransaction(
      decodeURIComponent(transactionCookie),
      state,
    );
    const tokens = await exchangeAuthorizationCode(code, transaction.verifier);
    const claims = await verifyProviderToken(tokens.id_token, oidcClientId());
    if (claims.nonce !== transaction.nonce) {
      throw new AuthenticationError("OIDC nonce validation failed");
    }
    if (
      typeof claims.sub !== "string" ||
      typeof claims.tenant_id !== "string"
    ) {
      throw new AuthenticationError("OIDC identity claims are incomplete");
    }
    await resolveOidcPrincipal({
      subject: claims.sub,
      tenantClaim: claims.tenant_id,
    });
    const session = await issueOidcSession({
      subject: claims.sub,
      tenantId: claims.tenant_id,
    });
    const response = NextResponse.redirect(
      new URL(transaction.returnTo, appBaseUrl()),
    );
    response.cookies.set(oidcSessionCookie, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60,
      path: "/",
    });
    response.cookies.set(
      oidcReviewAccessCookie,
      await sealReviewerAccessToken(tokens.access_token),
      {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        maxAge: 15 * 60,
        path: "/",
      },
    );
    response.cookies.set(oidcTransactionCookie, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 0,
      path: "/api/auth/callback",
    });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("x-request-id", requestId);
    return response;
  } catch (error) {
    return apiError(error, requestId);
  }
}
