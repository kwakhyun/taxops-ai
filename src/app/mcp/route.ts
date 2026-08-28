import { createHash } from "node:crypto";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { createTaxOpsMcpServer } from "@/lib/mcp/taxops-server";
import { getSessionUser } from "@/lib/auth/session";
import { getPermissions } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/security/rate-limit";
import { apiError, requestIdFrom } from "@/lib/http/errors";

export const runtime = "nodejs";
export const maxDuration = 30;

const sessionUserSchema = z.strictObject({
  id: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(["ADMIN", "REVIEWER", "ANALYST"]),
  initials: z.string(),
});

const handler = createMcpHandler(
  ({ authInfo }) => {
    const user = sessionUserSchema.parse(authInfo?.extra?.sessionUser);
    return createTaxOpsMcpServer(user);
  },
  {
    legacy: "stateless",
  },
);

function allowedValues(environmentKey: string, fallback: string[]) {
  const value = process.env[environmentKey];
  if (value)
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (process.env.NODE_ENV === "production") return [];
  return fallback;
}

async function dispatch(request: Request) {
  const requestId = requestIdFrom(request);
  try {
    const hosts = allowedValues("MCP_ALLOWED_HOSTS", [
      "localhost",
      "127.0.0.1",
    ]);
    const origins = allowedValues("MCP_ALLOWED_ORIGINS", [
      "localhost",
      "127.0.0.1",
    ]);
    if (!hosts.length || !origins.length) {
      return Response.json(
        {
          error: {
            code: "MCP_ORIGIN_CONFIG_REQUIRED",
            message: "MCP allowlist is not configured",
          },
        },
        { status: 503 },
      );
    }
    const rejected =
      hostHeaderValidationResponse(request, hosts) ??
      originValidationResponse(request, origins);
    if (rejected) return rejected;

    const user = await getSessionUser();
    await rateLimit(
      `${user.tenantId}:${user.id}:mcp`,
      60,
      60_000,
      user.tenantId,
    );
    const authorization =
      request.headers.get("authorization") ?? "demo-session";
    const authInfo: AuthInfo = {
      token: createHash("sha256").update(authorization).digest("hex"),
      clientId: user.id,
      scopes: getPermissions(user.role),
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      extra: { sessionUser: user },
    };
    return handler.fetch(request, { authInfo });
  } catch (error) {
    return apiError(error, requestId);
  }
}

export const POST = dispatch;
export const GET = dispatch;
export const DELETE = dispatch;

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { Allow: "GET, POST, DELETE, OPTIONS" },
  });
}
