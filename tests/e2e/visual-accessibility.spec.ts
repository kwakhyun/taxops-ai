import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Layout sweeps retain screenshots, not long video/trace recordings of every route.
test.use({ video: "off", trace: "off" });

async function expectNoAccessibilityViolations(page: Page, soft = false) {
  const check = soft ? expect.soft : expect;
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id}: ${violation.nodes
          .map((node) => node.target.join(" "))
          .join(", ")}`,
    )
    .join("\n");
  check(results.violations.length, `${page.url()} ${summary}`).toBe(0);
}

async function expectReadableTypography(page: Page, soft = false) {
  const check = soft ? expect.soft : expect;
  const result = await page.evaluate(() => {
    const visibleElements = [
      ...document.querySelectorAll<HTMLElement>("body *"),
    ].filter((element) => {
      const style = getComputedStyle(element);
      return (
        !element.closest(
          "[aria-hidden='true'], .sr-only, script, style, svg",
        ) &&
        element.getClientRects().length > 0 &&
        style.visibility !== "hidden"
      );
    });
    const smallText = visibleElements
      .filter((element) =>
        [...element.childNodes].some(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        ),
      )
      .map((element) => ({
        text: element.textContent?.trim().slice(0, 80),
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      }))
      .filter((element) => element.fontSize < 12);
    const smallMobileInputs = visibleElements
      .filter(
        (element) =>
          window.innerWidth <= 860 &&
          element.matches(
            "input:not([type='hidden']):not([type='file']), textarea, select",
          ),
      )
      .map((element) => ({
        label: element.getAttribute("aria-label") ?? element.id,
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      }))
      .filter((element) => element.fontSize < 16);
    return {
      smallText,
      smallMobileInputs,
      horizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      overflowSources: visibleElements
        .filter(
          (element) => element.getBoundingClientRect().right > innerWidth + 1,
        )
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          width: Math.round(element.getBoundingClientRect().width),
          right: Math.round(element.getBoundingClientRect().right),
        })),
    };
  });

  check(result.smallText, `Small text on ${page.url()}`).toEqual([]);
  check(result.smallMobileInputs, `Small input text on ${page.url()}`).toEqual(
    [],
  );
  check(
    result.horizontalOverflow,
    `Page overflow on ${page.url()}: ${JSON.stringify(result.overflowSources)}`,
  ).toBe(false);
}

test.describe("TaxOps AI accessibility and visual baselines", () => {
  test.beforeEach(async ({ request }) => {
    const reset = await request.post("/api/test/reset");
    expect(reset.ok()).toBe(true);
  });

  test("desktop control room stays accessible and visually stable", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "오늘 처리할 세무 업무" }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectReadableTypography(page);
    await expect(page).toHaveScreenshot("dashboard-desktop.png", {
      fullPage: true,
    });
    await expectNoAccessibilityViolations(page);
  });

  test("mobile engagement journey stays accessible and visually stable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/cases/vat-2025-q4");
    await expect(
      page.getByRole("heading", { name: "한빛테크 주식회사", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "모바일 주요 메뉴" }),
    ).toBeVisible();
    await expect(
      page.getByText("신고 전 최종 점검", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expectReadableTypography(page);
    await expect(
      page.getByRole("button", { name: "메뉴 열기", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    // Capture the entry state before Axe inspects and restores scroll positions.
    await expect(page).toHaveScreenshot("engagement-mobile.png", {
      fullPage: false,
    });
    await expectNoAccessibilityViolations(page);
  });

  test("mobile AI Partner keeps conversation and evidence accessible", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/assistant?matter=vat-2025-q4");
    const mobileSections = page.getByRole("tablist", {
      name: "AI 작업 영역",
    });
    await expect(mobileSections).toBeVisible();
    await expect(page.getByLabel("AI에게 질문")).toBeInViewport({ ratio: 1 });

    await mobileSections.getByRole("tab", { name: /참고 근거/ }).click();
    await expect(
      page.getByRole("complementary", { name: "응답 참고 근거" }),
    ).toBeVisible();
    await expectReadableTypography(page);
    await expectNoAccessibilityViolations(page);
    await mobileSections
      .getByRole("tab", { name: "대화", exact: true })
      .click();
    await expect(page.getByLabel("AI에게 질문")).toBeVisible();

    await page.evaluate(() => document.fonts.ready);
    await expectReadableTypography(page);
    await expectNoAccessibilityViolations(page);
    await expect(page).toHaveScreenshot("assistant-mobile.png", {
      fullPage: false,
    });
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 650 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    test(`workspace screen matrix at ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const login = await page.request.post("/api/auth/demo", {
        data: { user: "admin" },
      });
      expect(login.ok()).toBe(true);
      await page.setViewportSize(viewport);
      for (const route of [
        "/",
        "/cases",
        "/cases/new",
        "/cases/vat-2025-q4",
        "/documents",
        "/assistant?matter=vat-2025-q4",
        "/reviews",
        "/operations",
        "/evaluations",
        "/audit",
      ]) {
        if (route === "/reviews") {
          expect(
            (
              await page.request.post("/api/auth/demo", {
                data: { user: "reviewer" },
              })
            ).ok(),
          ).toBe(true);
        }
        await page.goto(route);
        await expect(page.getByRole("main")).toBeVisible();
        await expectReadableTypography(page, true);
        if (viewport.width === 390 || viewport.width === 1440) {
          await expectNoAccessibilityViolations(page, true);
          await page.evaluate(() => document.fonts.ready);
          const name = route.replace(/[^a-z0-9]/gi, "-") || "dashboard";
          await page.screenshot({
            path: testInfo.outputPath(`${name}-${viewport.width}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
        if (route === "/reviews") {
          expect(
            (
              await page.request.post("/api/auth/demo", {
                data: { user: "admin" },
              })
            ).ok(),
          ).toBe(true);
        }
      }
      await page
        .getByRole("button", { name: "세무 업무, 자료, 고객사 검색" })
        .click();
      await expect(
        page.getByRole("dialog", { name: "통합 검색" }),
      ).toBeVisible();
      await expectReadableTypography(page, true);
      expect.soft(errors, "Uncaught browser errors").toEqual([]);
    });
  }
});
