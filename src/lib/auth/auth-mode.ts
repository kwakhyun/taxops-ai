import { AuthenticationError } from "@/lib/auth/session-error";

export function resolveAuthMode(
  value: string | undefined,
  nodeEnv: string | undefined,
  allowProductionDemo = false,
): "demo" | "oidc" {
  const mode = value ?? (nodeEnv === "production" ? undefined : "demo");
  if (mode === "oidc") return mode;
  if (mode === "demo" && (nodeEnv !== "production" || allowProductionDemo)) {
    return mode;
  }
  throw new AuthenticationError("AUTH_MODE must be oidc in production");
}
