import type { TenantAiPolicy } from "./ai-policy.ts";

export function validateRegionalServiceEndpoint(input: {
  serviceName: string;
  url: string;
  token?: string;
  dataRegion?: string;
  allowedHosts?: string;
  policy: TenantAiPolicy;
  production: boolean;
}) {
  const url = new URL(input.url);
  if (!input.production) return url;
  const allowedHosts = new Set(
    (input.allowedHosts ?? "")
      .split(",")
      .map((host) => host.trim().toLocaleLowerCase("en-US"))
      .filter(Boolean),
  );
  if (
    url.protocol !== "https:" ||
    Boolean(url.username || url.password) ||
    (url.port !== "" && url.port !== "443") ||
    !input.token ||
    !input.dataRegion ||
    !input.policy.allowedProviderRegions.includes(input.dataRegion) ||
    !allowedHosts.has(url.hostname.toLocaleLowerCase("en-US"))
  ) {
    throw Object.assign(
      new Error(
        `${input.serviceName} must use an authenticated allowlisted HTTPS endpoint in a tenant-approved region`,
      ),
      { permanent: true },
    );
  }
  return url;
}
