import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AuthenticationError, getSessionUser } from "@/lib/auth/session";
import { getPermissions } from "@/lib/auth/rbac";
import { isPortfolioDemo } from "@/lib/runtime/portfolio-demo";
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./globals.css";
import "./workspace.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: {
    default: "TaxOps AI · 세무 업무 플랫폼",
    template: "%s · TaxOps AI",
  },
  description:
    "근거 검증과 승인 절차를 중심으로 설계된 AI 기반 세무 업무 플랫폼",
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
          {children}
        </AppShell>
      </body>
    </html>
  );
}
