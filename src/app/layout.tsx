import type { Metadata } from "next";
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
  return (
    <html lang="ko" data-scroll-behavior="smooth">
      <body>
        <a className="skip-link" href="#main-content">
          본문으로 건너뛰기
        </a>
        {children}
      </body>
    </html>
  );
}
