import { cookies } from "next/headers";
import {
  oidcReviewAccessCookie,
  oidcSessionCookie,
  revokeOidcSession,
  demoAuthCookie,
} from "@/lib/auth/session";
import { authStatusResponse } from "@/lib/auth/browser-response";
import { requestIdFrom } from "@/lib/http/errors";
import { logServerError } from "@/lib/observability/logger";

export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  let revocationFailed = false;
  try {
    const session = (await cookies()).get(oidcSessionCookie)?.value;
    if (session) await revokeOidcSession(session);
  } catch (error) {
    revocationFailed = true;
    logServerError(
      error,
      requestId,
      "SESSION_REVOCATION_FAILED",
      "auth.logout_failed",
    );
  }
  const response = authStatusResponse(
    request,
    revocationFailed ? "logout-incomplete" : "signed-out",
    requestId,
  );
  response.cookies.set(oidcSessionCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  response.cookies.set(oidcReviewAccessCookie, "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  response.cookies.set(demoAuthCookie, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  return response;
}
