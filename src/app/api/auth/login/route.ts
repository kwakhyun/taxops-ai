import { NextResponse } from "next/server";
import {
  createAuthorizationRequest,
  oidcTransactionCookie,
} from "@/lib/auth/oidc-flow";
import { apiError, requestIdFrom } from "@/lib/http/errors";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    if ((process.env.AUTH_MODE ?? "demo") !== "oidc") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    const url = new URL(request.url);
    const { authorizationUrl, transaction } = await createAuthorizationRequest(
      url.searchParams.get("returnTo"),
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
    return response;
  } catch (error) {
    return apiError(error, requestId);
  }
}
