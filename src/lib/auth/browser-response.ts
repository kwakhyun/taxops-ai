import { NextResponse } from "next/server";
import { appBaseUrl, oidcTransactionCookie } from "@/lib/auth/oidc-flow";
import { safeReturnTo } from "@/lib/auth/return-to";

export type AuthStatusReason =
  | "cancelled"
  | "invalid"
  | "unavailable"
  | "signed-out"
  | "logout-incomplete"
  | "reauthenticated";

export function clearAuthTransaction(response: NextResponse) {
  response.cookies.set(oidcTransactionCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/api/auth/callback",
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function authStatusResponse(
  request: Request,
  reason: AuthStatusReason,
  requestId: string,
  returnTo = "/",
  reauthenticate = false,
) {
  // Reverse proxies may expose an internal origin in request.url. Keep OIDC
  // recovery on the same public origin as the registered callback and cookies.
  let base: string | URL = request.url;
  if (process.env.AUTH_MODE === "oidc") {
    try {
      base = appBaseUrl();
    } catch {
      // A broken base-URL configuration must not break the public error page too.
    }
  }
  const target = new URL("/auth/status", base);
  target.search = new URLSearchParams({
    reason,
    returnTo: safeReturnTo(returnTo),
    ...(reauthenticate ? { reauthenticate: "1" } : {}),
  }).toString();
  const response = clearAuthTransaction(NextResponse.redirect(target, 303));
  response.headers.set("x-request-id", requestId);
  return response;
}
