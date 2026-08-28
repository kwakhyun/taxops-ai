import { NextResponse, type NextRequest } from "next/server";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isTrustedBrowserOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const configuredOrigin = process.env.APP_BASE_URL
      ? new URL(process.env.APP_BASE_URL).origin
      : request.nextUrl.origin;
    return new URL(origin).origin === configuredOrigin;
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const isBrowserPage =
    !request.nextUrl.pathname.startsWith("/api/") &&
    request.nextUrl.pathname !== "/mcp";
  if (
    process.env.AUTH_MODE === "oidc" &&
    isBrowserPage &&
    !request.cookies.has("taxops_session")
  ) {
    const login = new URL("/api/auth/login", request.url);
    login.searchParams.set(
      "returnTo",
      request.nextUrl.pathname + request.nextUrl.search,
    );
    const response = NextResponse.redirect(login);
    response.headers.set("x-request-id", requestId);
    return response;
  }

  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    unsafeMethods.has(request.method) &&
    !request.headers.has("authorization")
  ) {
    const fetchSite = request.headers.get("sec-fetch-site");
    const untrustedProductionOrigin =
      process.env.AUTH_MODE === "oidc" && !isTrustedBrowserOrigin(request);
    if (fetchSite === "cross-site" || untrustedProductionOrigin) {
      return Response.json(
        {
          error: {
            code: "CSRF_BLOCKED",
            message: "Cross-site request blocked",
          },
          meta: { requestId },
        },
        { status: 403, headers: { "x-request-id": requestId } },
      );
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  response.headers.set(
    "Content-Security-Policy",
    "frame-ancestors 'none'; object-src 'none'",
  );
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
