import { resetDemoStoreForTests } from "@/lib/repository/demo-store";

export const runtime = "nodejs";

export async function POST() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.E2E_RESET_ENABLED !== "true"
  ) {
    return new Response(null, { status: 404 });
  }
  resetDemoStoreForTests();
  return Response.json({ data: { reset: true } });
}
