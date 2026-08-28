import { NextResponse } from "next/server";
import { z } from "zod";
import { demoAuthCookie } from "@/lib/auth/session";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";

const schema = z.strictObject({
  user: z.enum(["analyst", "reviewer", "admin"]),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production" && !isPortfolioDemo()) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  }
  const { user } = schema.parse(await request.json());
  const response = NextResponse.json({ data: { user } });
  response.cookies.set(demoAuthCookie, user, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 8,
    path: "/",
  });
  return response;
}
