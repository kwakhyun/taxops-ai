import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AuthenticationError, getSessionUser } from "@/lib/auth/session";
import { safeReturnTo } from "@/lib/auth/return-to";
import { getPermissions } from "@/lib/auth/rbac";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let user;
  try {
    user = await getSessionUser();
  } catch (error) {
    if (
      error instanceof AuthenticationError &&
      process.env.AUTH_MODE === "oidc"
    ) {
      const returnTo = safeReturnTo(
        (await headers()).get("x-taxops-return-to"),
      );
      redirect("/api/auth/login?" + new URLSearchParams({ returnTo }));
    }
    throw error;
  }
  return (
    <AppShell
      user={user}
      permissions={getPermissions(user.role)}
      portfolioDemo={isPortfolioDemo()}
    >
      {children}
    </AppShell>
  );
}
