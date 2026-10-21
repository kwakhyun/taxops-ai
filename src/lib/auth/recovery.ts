import { safeReturnTo } from "@/lib/auth/return-to";

export function authRecoveryUrl(status: number, returnTo: string) {
  if (status !== 401) return undefined;
  return (
    "/api/auth/login?" +
    new URLSearchParams({
      returnTo: safeReturnTo(returnTo),
      reauthenticate: "1",
    })
  );
}
