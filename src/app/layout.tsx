import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AuthenticationError, getSessionUser } from "@/lib/auth/session";
import { getPermissions } from "@/lib/auth/rbac";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "TaxOps AI · 세무 업무 워크스페이스",
    template: "%s · TaxOps AI",
  },
  description: "근거와 승인 흐름을 중심으로 설계된 AI-native 세무 업무 플랫폼",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  let user;
  try {
    user = await getSessionUser();
  } catch (error) {
    if (
      error instanceof AuthenticationError &&
      process.env.AUTH_MODE === "oidc"
    ) {
      redirect("/api/auth/login");
    }
    throw error;
  }
  const permissions = getPermissions(user.role);
  return (
    <html lang="ko" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">
          본문으로 건너뛰기
        </a>
        <AppShell
          user={user}
          permissions={permissions}
          portfolioDemo={isPortfolioDemo()}
        >
          <div id="main-content">{children}</div>
        </AppShell>
      </body>
    </html>
  );
}
