import { expect, test } from "@playwright/test";

test.use({ video: "off" });
test.setTimeout(90_000);
test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/test/reset")).ok()).toBe(true);
});

test("logout clears the demo identity and stays on a signed-out page", async ({
  page,
  context,
}) => {
  await page.request.post("/api/auth/demo", { data: { user: "admin" } });
  await page.goto("/");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/status\?reason=signed-out/);
  await expect(
    page.getByRole("heading", { name: "로그아웃되었습니다." }),
  ).toBeVisible();
  const cookies = await context.cookies();
  expect(
    cookies.some((cookie) =>
      [
        "taxops_demo_user",
        "taxops_session",
        "taxops_review_access",
        "taxops_oidc_transaction",
      ].includes(cookie.name),
    ),
  ).toBe(false);
  await page.reload();
  await expect(page).toHaveURL(/\/auth\/status\?reason=signed-out/);
  await expect(
    page.getByRole("navigation", { name: "세무 업무 메뉴" }),
  ).toHaveCount(0);
});

test("login errors render a readable mobile recovery screen, not raw JSON", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/api/auth/callback?error=access_denied&state=invalid");
  await expect(page).toHaveURL(/\/auth\/status\?reason=invalid/);
  await expect(
    page.getByRole("heading", { name: "로그인을 완료하지 못했습니다." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "로그인", exact: true }),
  ).toBeInViewport();
  await page.goto(
    "/auth/status?reason=cancelled&returnTo=%2Freviews&reauthenticate=1",
  );
  await expect(
    page.getByRole("heading", { name: "로그인이 취소되었습니다." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "로그인", exact: true }),
  ).toHaveAttribute("href", /reauthenticate=1/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

for (const expiredAt of ["GET", "POST"] as const) {
  test(`review reauthentication preserves the draft and requires an explicit retry (${expiredAt})`, async ({
    page,
    context,
  }) => {
    await page.request.post("/api/auth/demo", { data: { user: "reviewer" } });
    await page.goto("/reviews");
    const note = "원문 대조 완료. 재인증 후에도 이 검토 의견을 유지합니다.";
    await page.getByLabel("검토 의견").fill(note);
    let denied = false;
    let decisions = 0;
    await page.route("**/api/v1/reviews/*", async (route) => {
      if (route.request().method() === "POST") decisions++;
      if (route.request().method() === expiredAt && !denied) {
        denied = true;
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "REVIEW_REAUTH_REQUIRED",
              message: "검토자 인증이 만료되었습니다.",
            },
          }),
        });
      } else await route.continue();
    });
    // The provider boundary is covered with signed JWTs in auth-lifecycle.test.ts.
    // This browser test isolates the recovery UX without a real identity provider.
    await context.route("**/api/auth/login?**", (route) =>
      route.fulfill({
        status: 303,
        headers: {
          location: "/auth/status?reason=reauthenticated&returnTo=%2Freviews",
        },
      }),
    );
    await page.getByRole("button", { name: "승인", exact: true }).click();
    const recovery = page.getByRole("link", { name: "다시 인증하기 (새 탭)" });
    await expect(recovery).toBeVisible();
    await expect(page.getByLabel("검토 의견")).toHaveValue(note);
    const popupPromise = context.waitForEvent("page");
    await recovery.click();
    const popup = await popupPromise;
    await expect(
      popup.getByRole("heading", { name: "인증이 갱신되었습니다." }),
    ).toBeVisible();
    await popup.close();
    expect(decisions).toBe(expiredAt === "POST" ? 1 : 0);
    await expect(page.getByLabel("검토 의견")).toHaveValue(note);
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await expect(page.getByText("검토조서를 승인했습니다.")).toBeVisible();
    expect(decisions).toBe(expiredAt === "POST" ? 2 : 1);
  });
}

test("document evidence retains the preview and can be approved after reauthentication", async ({
  page,
  context,
}) => {
  await page.request.post("/api/auth/demo", { data: { user: "reviewer" } });
  await page.goto("/documents?matter=vat-2025-q4");
  await page
    .getByRole("button", { name: "검색 근거 검토", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "AI 검색 근거 검토" });
  await expect(dialog.getByText("원본 파일 해시(SHA-256)")).toBeVisible();
  let denied = false;
  await page.route("**/api/v1/documents/*/evidence", async (route) => {
    if (route.request().method() === "PATCH" && !denied) {
      denied = true;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "REVIEW_REAUTH_REQUIRED",
            message: "검토자 인증이 만료되었습니다.",
          },
        }),
      });
    } else await route.continue();
  });
  await context.route("**/api/auth/login?**", (route) =>
    route.fulfill({
      status: 303,
      headers: {
        location: "/auth/status?reason=reauthenticated&returnTo=%2Fdocuments",
      },
    }),
  );
  await dialog.getByRole("button", { name: "검색 근거로 승인" }).click();
  const recovery = dialog.getByRole("link", { name: "다시 인증하기 (새 탭)" });
  await expect(recovery).toBeVisible();
  await expect(dialog.getByText("원본 파일 해시(SHA-256)")).toBeVisible();
  const popupPromise = context.waitForEvent("page");
  await recovery.click();
  const popup = await popupPromise;
  await expect(
    popup.getByRole("heading", { name: "인증이 갱신되었습니다." }),
  ).toBeVisible();
  await popup.close();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "검색 근거로 승인" }).click();
  await expect(dialog).toBeHidden();
});
