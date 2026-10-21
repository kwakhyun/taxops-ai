import { NextResponse } from "next/server";
import {
  createAuthorizationRequest,
  oidcTransactionCookie,
} from "@/lib/auth/oidc-flow";
import { apiError, requestIdFrom } from "@/lib/http/errors";
import { authStatusResponse } from "@/lib/auth/browser-response";
import { AuthenticationError, getSessionUser } from "@/lib/auth/session";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    if ((process.env.AUTH_MODE ?? "demo") !== "oidc") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    const url = new URL(request.url);
    const reauthenticate = url.searchParams.get("reauthenticate") === "1";
    let expectedUser;
    if (reauthenticate) {
      try {
        const user = await getSessionUser();
        expectedUser = { id: user.id, tenantId: user.tenantId };
      } catch (error) {
        if (!(error instanceof AuthenticationError)) throw error;
      }
    }
    const { authorizationUrl, transaction } = await createAuthorizationRequest(
      url.searchParams.get("returnTo"),
      { reauthenticate, expectedUser },
    );
    const response = NextResponse.redirect(authorizationUrl);
    response.cookies.set(oidcTransactionCookie, transaction, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60,
      path: "/api/auth/callback",
    });
    response.headers.set("x-request-id", requestId);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    apiError(error, requestId);
    const url = new URL(request.url);
    return authStatusResponse(
      request,
      "unavailable",
      requestId,
      url.searchParams.get("returnTo") ?? "/",
      url.searchParams.get("reauthenticate") === "1",
    );
  }
}
