import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { safeReturnTo } from "@/lib/auth/return-to";
import "./status.css";

export const metadata: Metadata = {
  title: "로그인 안내",
  robots: { index: false, follow: false },
};

const notices = {
  cancelled: {
    title: "로그인이 취소되었습니다.",
    detail:
      "로그인을 완료하지 않아 업무 화면으로 이동하지 않았습니다. 아래에서 다시 시도할 수 있습니다.",
  },
  invalid: {
    title: "로그인을 완료하지 못했습니다.",
    detail:
      "로그인 요청이 만료되었거나 계정 정보를 확인할 수 없습니다. 다시 시도해 주세요. 문제가 계속되면 담당 관리자에게 문의해 주세요.",
  },
  unavailable: {
    title: "인증 서비스에 연결하지 못했습니다.",
    detail: "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  },
  "signed-out": {
    title: "로그아웃되었습니다.",
    detail:
      "이 브라우저의 TaxOps AI 로그인 정보를 삭제했습니다. 조직의 다른 서비스에서는 로그인이 유지될 수 있습니다.",
  },
  "logout-incomplete": {
    title: "브라우저에서 로그아웃했습니다.",
    detail:
      "서버 연결 오류로 세션 폐기를 확인하지 못했습니다. 담당 관리자에게 문의해 주세요. 이 브라우저의 로그인 정보는 삭제했습니다.",
  },
  reauthenticated: {
    title: "인증이 갱신되었습니다.",
    detail:
      "이 탭을 닫고 이전 업무 탭으로 돌아가세요. 입력한 검토 의견을 확인한 뒤 다시 처리해 주세요. 승인이나 반려는 자동으로 실행되지 않습니다.",
  },
};

export default async function AuthStatusPage({
  searchParams,
}: {
  searchParams: Promise<{
    reason?: string;
    returnTo?: string;
    reauthenticate?: string;
  }>;
}) {
  const query = await searchParams;
  const reason =
    query.reason && Object.hasOwn(notices, query.reason)
      ? (query.reason as keyof typeof notices)
      : "invalid";
  const notice = notices[reason];
  const returnTo = safeReturnTo(query.returnTo ?? null);
  const login =
    "/api/auth/login?" +
    new URLSearchParams({
      returnTo,
      ...(query.reauthenticate === "1" ? { reauthenticate: "1" } : {}),
    });
  return (
    <main id="main-content" className="auth-status-page">
      <section
        className="card auth-status-card"
        aria-labelledby="auth-status-title"
      >
        <ShieldCheck size={32} aria-hidden="true" />
        <span className="card-kicker">TaxOps AI</span>
        <h1 id="auth-status-title">{notice.title}</h1>
        <p>{notice.detail}</p>
        <a
          className="button button-primary"
          href={reason === "reauthenticated" ? returnTo : login}
        >
          {reason === "reauthenticated" ? "업무 화면 열기" : "로그인"}
        </a>
      </section>
    </main>
  );
}
