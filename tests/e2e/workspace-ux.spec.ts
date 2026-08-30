import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import report from "../../artifacts/evaluation-report.json" with { type: "json" };

async function mockVisualViewport(page: Page, height?: number, offsetTop = 0) {
  await page.evaluate(
    ({ height, offsetTop }) => {
      const viewport = window.visualViewport!;
      if (height === undefined) {
        Reflect.deleteProperty(viewport, "height");
        Reflect.deleteProperty(viewport, "offsetTop");
      } else {
        Object.defineProperties(viewport, {
          height: { configurable: true, value: height },
          offsetTop: { configurable: true, value: offsetTop },
        });
      }
      viewport.dispatchEvent(new Event("resize"));
    },
    { height, offsetTop },
  );
}

async function expectComposerClear(page: Page) {
  await expect(page.getByLabel("AI에게 질문")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#assistant-draft-notice")).toBeInViewport({
    ratio: 1,
  });
  const layout = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>(
      '[data-testid="message-scroll"]',
    )!;
    const note = document.querySelector<HTMLElement>(
      "#assistant-draft-notice",
    )!;
    const nav = document.querySelector<HTMLElement>(
      ".mobile-bottom-navigation",
    )!;
    return {
      conversationHeight: scroll.clientHeight,
      noteBottom: note.getBoundingClientRect().bottom,
      navTop: nav.getClientRects().length
        ? nav.getBoundingClientRect().top
        : innerHeight,
      overflowing:
        document.documentElement.scrollWidth > innerWidth ||
        document.documentElement.scrollHeight > innerHeight + 1,
    };
  });
  expect(layout.noteBottom).toBeLessThanOrEqual(layout.navTop);
  expect(layout.conversationHeight).toBeGreaterThan(
    page.viewportSize()!.height < 500 ? 65 : 155,
  );
  expect(layout.overflowing).toBe(false);
}

test.describe("Workspace UX regression", () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post("/api/test/reset")).ok()).toBe(true);
  });

  test("chat never clips its composer on small, short, tablet or desktop screens", async ({
    page,
  }) => {
    for (const viewport of [
      { width: 1440, height: 720 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 650 },
      { width: 320, height: 568 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/assistant");
      await expectComposerClear(page);
      const input = page.getByLabel("AI에게 질문");
      await input.fill(
        "검토할 자료와 추가 확인 사항을 정리해 주세요. "
          .repeat(70)
          .slice(0, 2000),
      );
      await expect(input).toBeInViewport({ ratio: 1 });
      await expect(
        page.getByRole("button", { name: "질문 보내기" }),
      ).toBeInViewport({ ratio: 1 });
      await input.clear();
      await expectComposerClear(page);
    }
  });

  test("mobile AI streams an answer, preserves the draft across tabs and uploads without leaving the conversation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/assistant?matter=vat-2025-q4");
    await page
      .getByRole("button", { name: /매입세액 불공제 의심 항목/ })
      .click();
    await expect(page.getByRole("button", { name: "다시 생성" })).toBeEnabled({
      timeout: 15_000,
    });
    await expect(page.getByRole("log")).toContainText("검토 결론");
    await expectComposerClear(page);
    await page.getByLabel("AI에게 질문").fill("추가 질문 초안");
    await page.getByRole("tab", { name: /참고 근거/ }).click();
    await expect(
      page.getByRole("complementary", { name: "응답 참고 근거" }),
    ).toContainText("분석 항목 6개 중 6개 근거 확인");
    await page.getByRole("tab", { name: "대화", exact: true }).click();
    await expect(page.getByLabel("AI에게 질문")).toHaveValue("추가 질문 초안");
    await page.getByRole("button", { name: "자료 첨부", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "현재 업무에 자료 추가" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("업로드할 세무 자료 선택").setInputFiles({
      name: "mobile-attachment.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "모바일 첨부 자료: 업무 관련성을 검토할 거래 내역입니다.",
      ),
    });
    await expect(dialog.getByRole("status")).toContainText(
      "대기열에 추가됐습니다.",
    );
    await dialog.getByRole("button", { name: "자료 첨부 닫기" }).click();
    await expect(page.getByLabel("AI에게 질문")).toHaveValue("추가 질문 초안");
    await expect(page.getByRole("log")).toContainText("검토 결론");
    await page.getByRole("button", { name: "다시 생성" }).click();
    await expect(page.getByRole("button", { name: "다시 생성" })).toBeEnabled({
      timeout: 15_000,
    });
    await expect(page.getByRole("log")).toContainText("검토 결론");
  });

  test("the visual viewport keeps the composer and conversation above an on-screen keyboard", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/assistant");
    await page.getByLabel("AI에게 질문").fill("매입세액 불공제 검토");
    await mockVisualViewport(page, 330, 20);
    await expect(page.locator(".app-main-assistant")).toHaveAttribute(
      "data-keyboard-open",
      "true",
    );
    await expect(
      page.getByRole("navigation", { name: "모바일 주요 메뉴" }),
    ).toBeHidden();
    const bounds = await page.getByLabel("AI에게 질문").boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(350);
    expect(
      await page
        .getByTestId("message-scroll")
        .evaluate((element) => element.clientHeight),
    ).toBeGreaterThan(100);
    await mockVisualViewport(page);
    await expect(page.getByRole("button", { name: "메뉴 열기" })).toBeVisible();
    await expect(page.getByLabel("AI에게 질문")).toHaveValue(
      "매입세액 불공제 검토",
    );
    await expectComposerClear(page);
  });

  test("an in-flight AI response can be stopped and a new question can be sent", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/assistant");
    let pending: Route | undefined;
    await page.route("**/api/v1/assistant", (route) => {
      pending = route;
    });
    const requested = page.waitForRequest("**/api/v1/assistant");
    await page.getByLabel("AI에게 질문").fill("중지 동작을 확인합니다");
    await page.getByRole("button", { name: "질문 보내기" }).click();
    await requested;
    await page.getByRole("button", { name: "응답 중지" }).click();
    await expect(
      page.getByRole("button", { name: "질문 보내기" }),
    ).toBeVisible();
    await pending?.abort().catch(() => undefined);
    await page.unroute("**/api/v1/assistant");
    await page
      .getByLabel("AI에게 질문")
      .fill("매입세액 불공제 의심 항목과 신고서 차이를 찾아 주세요");
    await page.getByRole("button", { name: "질문 보내기" }).click();
    await expect(page.getByRole("log")).toContainText("검토 결론");
  });

  test("mobile navigation contains keyboard focus and restores it after closing", async ({
    page,
  }) => {
    await page.request.post("/api/auth/demo", { data: { user: "admin" } });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/");
    const trigger = page.getByRole("button", { name: "메뉴 열기" });
    await trigger.click();
    await expect(
      page.locator(".sidebar").getByRole("button", { name: "메뉴 닫기" }),
    ).toBeFocused();
    await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
    await page
      .locator(".sidebar")
      .getByRole("button", { name: "로그아웃" })
      .focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(".sidebar .brand")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page
      .getByRole("navigation", { name: "운영 메뉴" })
      .getByRole("link", { name: "감사 로그" })
      .click();
    await expect(page).toHaveURL(/\/audit$/);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("AI errors remain readable and the same question can be retried", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/assistant");
    await page.route("**/api/v1/assistant", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "AI_UNAVAILABLE",
            message: "응답을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          },
          meta: { requestId: "test-ai-unavailable" },
        }),
      }),
    );
    await page
      .getByLabel("AI에게 질문")
      .fill("매입세액 불공제 항목을 분석해 주세요");
    await page.getByRole("button", { name: "질문 보내기" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "응답을 생성하지 못했습니다" }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("alert").filter({ hasText: "응답을 생성하지 못했습니다" }),
    ).not.toContainText("requestId");
    await page.unroute("**/api/v1/assistant");
    await page.getByRole("button", { name: "다시 생성" }).click();
    await expect(page.getByRole("button", { name: "다시 생성" })).toBeEnabled({
      timeout: 15_000,
    });
    await expect(page.getByRole("log")).toContainText("검토 결론");
    await expect(
      page.getByText(
        "응답을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        { exact: true },
      ),
    ).toBeHidden();
  });

  test("mobile document intake has a usable matter picker and refreshes the list", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/documents");
    await expect(
      page.getByRole("button", { name: "파일 선택" }),
    ).toBeDisabled();
    await page.getByLabel("연결할 세무 업무").selectOption("vat-2025-q4");
    await expect(page.getByRole("button", { name: "파일 선택" })).toBeEnabled();
    await page.getByLabel("업로드할 세무 자료 선택").setInputFiles({
      name: "mobile-intake.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("고객사가 제출한 기업업무추진비 거래 내역입니다."),
    });
    await expect(page.getByRole("status")).toContainText(
      "대기열에 추가됐습니다.",
    );
    await page.getByLabel("자료 검색").fill("mobile-intake");
    await expect(
      page.getByRole("row").filter({ hasText: "mobile-intake.txt" }),
    ).toContainText("한빛테크");
    await page.getByRole("button", { name: "처리 중", exact: true }).click();
    await expect(page.getByText("자료 1건", { exact: true })).toBeVisible();
  });

  test("mobile case wizard validates each step and focuses the next heading", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/cases/new");
    await page
      .getByRole("button", { name: "세무 업무, 자료, 고객사 검색" })
      .click();
    await expect(page.getByRole("dialog", { name: "통합 검색" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByLabel("고객사명").fill("  ");
    await page.getByRole("button", { name: "계속" }).click();
    await expect(page.locator(".form-panel").getByRole("alert")).toContainText(
      "고객사명은 2자 이상",
    );
    await page.getByLabel("고객사명").fill("모바일 검증 고객사");
    await page.getByRole("button", { name: "계속" }).click();
    await expect(
      page.getByRole("heading", { name: "업무 범위", exact: true }),
    ).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "업무 범위", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.getByLabel("신고 대상 기간").fill("잘못된 기간");
    await page.getByRole("button", { name: "계속" }).click();
    await expect(page.locator(".form-panel").getByRole("alert")).toContainText(
      "기간은",
    );
    await page.getByLabel("신고 대상 기간").fill("2026년 제1기 예정신고");
    await page.getByRole("button", { name: "계속" }).click();
    await page.getByRole("button", { name: "계속" }).click();
    await page.getByRole("button", { name: "업무 등록", exact: true }).click();
    await expect(page).toHaveURL(/\/cases\/matter-/);
    await expect(
      page.getByRole("heading", { name: "모바일 검증 고객사", level: 1 }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "세무 업무, 자료, 고객사 검색" })
      .click();
    await page.getByLabel("통합 검색어").fill("모바일 검증 고객사");
    await expect(
      page
        .getByRole("dialog")
        .getByRole("link", { name: /모바일 검증 고객사/ }),
    ).toBeVisible();
  });

  test("review approval updates the inbox and stays bound to the selected workpaper", async ({
    page,
  }) => {
    await page.request.post("/api/auth/demo", { data: { user: "reviewer" } });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/reviews");
    const pending = await page.locator(".review-inbox h2").innerText();
    await page
      .getByLabel("검토 의견")
      .fill("근거 원문과 계산 결과를 확인하여 승인합니다.");
    await page.getByRole("button", { name: "승인", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "검토조서를 승인했습니다.",
    );
    await expect(page.locator(".review-inbox h2")).not.toHaveText(pending);
    await expect(page.locator(".review-list-item").first()).toContainText(
      "승인 완료",
    );
    await page.reload();
    await expect(page.locator(".review-document")).toContainText("승인 완료");
    await expect(
      page.getByRole("button", { name: "승인", exact: true }),
    ).toBeHidden();
  });

  test("search and evidence dialogs stay inside the viewport and restore focus", async ({
    page,
  }) => {
    await page.request.post("/api/auth/demo", { data: { user: "reviewer" } });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto("/documents?matter=vat-2025-q4");
    const search = page.getByRole("button", {
      name: "세무 업무, 자료, 고객사 검색",
    });
    await search.click();
    let dialog = page.getByRole("dialog", { name: "통합 검색" });
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("textbox")).toBeFocused();
    await mockVisualViewport(page, 330, 20);
    const searchBounds = await dialog.boundingBox();
    expect(searchBounds!.y).toBeGreaterThanOrEqual(20);
    expect(searchBounds!.y + searchBounds!.height).toBeLessThanOrEqual(350);
    await mockVisualViewport(page);
    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest("dialog")),
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(search).toBeFocused();
    const row = page
      .getByRole("row")
      .filter({ hasText: "기업업무추진비_업무관련성_소명서.txt" });
    const review = row.getByRole("button", { name: "검색 근거 검토" });
    await review.click();
    dialog = page.getByRole("dialog", { name: "AI 검색 근거 검토" });
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "검색 근거로 승인" }),
    ).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByText("원본 파일 해시(SHA-256)")).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(review).toBeFocused();
  });

  test("evidence preview can be retried after a failed request without approving unseen content", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    expect(
      (
        await page.request.post("/api/auth/demo", {
          data: { user: "reviewer" },
        })
      ).ok(),
    ).toBe(true);
    await page.goto("/documents?matter=vat-2025-q4");
    const endpoint = "**/api/v1/documents/doc_evidence_review/evidence";
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "근거를 불러오지 못했습니다." },
        }),
      }),
    );
    await page
      .getByRole("button", { name: "검색 근거 검토", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "AI 검색 근거 검토" });
    await expect(dialog.getByRole("alert")).toContainText(
      "근거를 불러오지 못했습니다.",
    );
    await expect(
      dialog.getByRole("button", { name: "검색 근거로 승인" }),
    ).toBeDisabled();
    await page.unroute(endpoint);
    await dialog.getByRole("button", { name: "다시 불러오기" }).click();
    await expect(dialog.getByText("원본 파일 해시(SHA-256)")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "검색 근거로 승인" }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "근거 검토 닫기" }).click();
    await expect(dialog).toBeHidden();
  });

  test("audit search, outcome filters, empty state and CSV export work", async ({
    page,
  }) => {
    await page.request.post("/api/auth/demo", { data: { user: "admin" } });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.goto("/audit");
    await page.getByRole("button", { name: "차단", exact: true }).click();
    const rows = page.locator(".audit-table tbody tr");
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) await expect(row).toContainText("차단");
    const exported = page.waitForEvent("download");
    await page.getByRole("button", { name: "검색 결과 내보내기" }).click();
    expect((await exported).suggestedFilename()).toBe("taxops-audit.csv");
    await page.getByLabel("감사 로그 검색").fill("존재하지않는추적아이디");
    await expect(
      page.getByText("조건에 맞는 감사 기록이 없습니다."),
    ).toBeVisible();
    await page.getByRole("button", { name: "검색 초기화" }).click();
    await expect(page.getByLabel("감사 로그 검색")).toHaveValue("");
    expect(await rows.count()).toBeGreaterThan(0);
  });

  test("quality meters use the report values and overflowing tables are keyboard scrollable", async ({
    page,
  }) => {
    await page.request.post("/api/auth/demo", { data: { user: "admin" } });
    await page.goto("/evaluations");
    for (const [key, label] of [
      ["retrievalRecallAt5", "검색 재현율"],
      ["generatedCitationSupport", "답변 근거 일치율"],
      ["claimIntegrityAdversarialPassRate", "주장 무결성"],
      ["abstentionAccuracy", "답변 보류 정확도"],
      ["injectionBlockRate", "공격 차단률"],
    ] as const) {
      const meter = page.getByRole("meter", { name: label });
      await expect(meter).toHaveAttribute("min", "0");
      await expect(meter).toHaveAttribute("max", "100");
      await expect(meter).toHaveAttribute("value", String(report.metrics[key]));
      await expect(meter).toHaveAttribute(
        "low",
        String(report.thresholds[key]),
      );
    }
    await page.goto("/audit");
    const table = page.getByRole("region", { name: "감사 기록 목록" });
    await expect(table).toHaveAttribute("tabindex", "0");
    await expect(page.locator(".table-scroll-hint")).toBeVisible();
    await table.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => table.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await page.setViewportSize({ width: 390, height: 650 });
    await expect(page.locator(".table-scroll-hint")).toBeHidden();
  });
});
