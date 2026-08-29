import { timingSafeEqual } from "node:crypto";

export function healthDetailsAuthorized(
  authorization: string | null,
  configuredToken: string | undefined,
) {
  if (!configuredToken || configuredToken.length < 32 || !authorization) {
    return false;
  }
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length), "utf8");
  const expected = Buffer.from(configuredToken, "utf8");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
