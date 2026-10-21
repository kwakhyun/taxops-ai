import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AuthStatusPage from "@/app/auth/status/page";
import { AuthRecovery } from "@/components/auth-recovery";
import { ReviewWorkspace } from "@/components/review-workspace";
import { listReviewRequests } from "@/lib/repository/demo-store";
import { demoUsers } from "@/lib/domain/fixtures";

describe("public authentication recovery views", () => {
  it("does not accept review input before the client is hydrated", () => {
    const html = renderToStaticMarkup(
      <ReviewWorkspace
        requests={listReviewRequests(demoUsers.reviewer!)}
        reviewerName={demoUsers.reviewer!.name}
      />,
    );
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain("검토 화면을 준비하고 있습니다.");
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(
      true,
    );
  });

  it.each([
    ["cancelled", "로그인이 취소되었습니다."],
    ["invalid", "로그인을 완료하지 못했습니다."],
    ["signed-out", "로그아웃되었습니다."],
    ["logout-incomplete", "서버 연결 오류로 세션 폐기를 확인하지 못했습니다."],
    ["reauthenticated", "승인이나 반려는 자동으로 실행되지 않습니다."],
  ])(
    "renders %s without a session or an automatic login redirect",
    async (reason, expected) => {
      const html = renderToStaticMarkup(
        await AuthStatusPage({
          searchParams: Promise.resolve({
            reason,
            returnTo: "/reviews",
            reauthenticate: "1",
          }),
        }),
      );
      expect(html).toContain(expected);
      expect(html).toContain('id="main-content"');
      expect(html).toContain('aria-labelledby="auth-status-title"');
      expect(html).not.toMatch(/http-equiv|window\.location|세무 업무 메뉴/);
      if (reason === "reauthenticated")
        expect(html).toContain('href="/reviews"');
      else
        expect(html).toContain(
          "/api/auth/login?returnTo=%2Freviews&amp;reauthenticate=1",
        );
    },
  );

  it("does not reflect untrusted status text or an external retry destination", async () => {
    const html = renderToStaticMarkup(
      await AuthStatusPage({
        searchParams: Promise.resolve({
          reason: '<script>alert("secret")</script>',
          returnTo: "https://evil.example",
        }),
      }),
    );
    expect(html).toContain("로그인을 완료하지 못했습니다.");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("returnTo=%2F");
  });

  it("opens recovery in a separate tab without giving it access to the original tab", () => {
    const html = renderToStaticMarkup(
      <AuthRecovery href="/api/auth/login?reauthenticate=1" />,
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("이 탭의 입력 내용은 유지됩니다.");
    expect(renderToStaticMarkup(<AuthRecovery />)).toBe("");
  });
});
