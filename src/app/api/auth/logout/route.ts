import { NextResponse } from "next/server";
import { oidcReviewAccessCookie, oidcSessionCookie } from "@/lib/auth/session";

export async function POST(request: Request) {
  const response = NextResponse.redirect(
    new URL("/api/auth/login", request.url),
    {
      status: 303,
    },
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
  return response;
}
