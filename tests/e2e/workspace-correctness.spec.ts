import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/api/test/reset")).ok()).toBe(true);
});

test("long conversations and regeneration send only the current user question", async ({
  page,
}) => {
  const payloads: Array<{
    messages: Array<{ role: string; parts: Array<{ text?: string }> }>;
  }> = [];
  await page.route("**/api/v1/assistant", async (route) => {
    payloads.push(route.request().postDataJSON());
    const frames = [
      { type: "start", messageId: `answer-${payloads.length}` },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: `응답 ${payloads.length}` },
      { type: "text-end", id: "text" },
      { type: "finish" },
    ];
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      body:
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
        "data: [DONE]\n\n",
    });
  });
  await page.goto("/assistant");
  for (let i = 1; i <= 20; i++) {
    await page.getByLabel("AI에게 질문").fill(`세무 질문 ${i}`);
    await page
      .getByRole("button", { name: "질문 보내기", exact: true })
      .click();
    await expect(page.getByText(`응답 ${i}`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "다시 생성" })).toBeEnabled();
  }
  await page.getByRole("button", { name: "다시 생성" }).click();
  await expect.poll(() => payloads.length).toBe(21);
  for (const payload of payloads) {
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0]?.role).toBe("user");
  }
  expect(payloads.at(-1)?.messages[0]?.parts[0]?.text).toBe("세무 질문 20");
});

test("analysts can inspect the current review state without a forbidden navigation", async ({
  page,
}) => {
  await page.goto("/cases/vat-2025-q4");
  await page
    .locator(".engagement-stage-list")
    .getByRole("link", { name: /검토 및 승인/ })
    .click();
  await expect(page).toHaveURL(/#review-status$/);
  await expect(page.getByText(/최신 분석 검토 상태/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "요청한 화면을 찾을 수 없습니다." }),
  ).toHaveCount(0);
  await expect(
    page.locator('a[href="/reviews"], a[href="/audit"]'),
  ).toHaveCount(0);
});

test("upload jobs refresh at completion and recover from a status query failure", async ({
  page,
}) => {
  let recovered = false;
  await page.route("**/api/v1/uploads", (route) =>
    route.fulfill({
      status: 202,
      json: { data: { job: { id: "test-upload-job" }, deduplicated: false } },
    }),
  );
  await page.route("**/api/v1/jobs/test-upload-job", (route) => {
    if (!recovered)
      return route.fulfill({
        status: 503,
        json: { error: { message: "일시적으로 상태를 조회할 수 없습니다." } },
      });
    return route.fulfill({
      json: {
        data: { status: "SUCCEEDED", progress: 100 },
        meta: { processingAvailable: true },
      },
    });
  });
  await page.goto("/documents?matter=vat-2025-q4");
  await page.getByLabel("업로드할 세무 자료 선택").setInputFiles({
    name: "job-test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("테스트 자료"),
  });
  const job = page.locator('[data-job-id="test-upload-job"]');
  await expect(job).toContainText("일시적으로 상태를 조회할 수 없습니다.");
  recovered = true;
  await job.getByRole("button", { name: "처리 상태 다시 확인" }).click();
  await expect(job).toContainText("자료 처리 완료");
  await expect(job.getByRole("button")).toHaveCount(0);
});

test("server pagination keeps filters and exports the whole audit search", async ({
  page,
  request,
}) => {
  await request.post("/api/auth/demo", { data: { user: "admin" } });
  const api = await request.get("/api/v1/audit?pageSize=2");
  const first = await api.json();
  expect(first.data).toHaveLength(2);
  expect(first.meta.total).toBeGreaterThan(2);
  const next = await (
    await request.get("/api/v1/audit?pageSize=2&page=2")
  ).json();
  expect(
    new Set(
      [...first.data, ...next.data].map((item: { id: string }) => item.id),
    ).size,
  ).toBe(4);
  const invalid = await request.get("/api/v1/audit?from=2026-02-30");
  expect(invalid.status()).toBe(400);
  const csv = await request.get("/api/v1/audit?pageSize=2&page=2&format=csv");
  expect((await csv.text()).split("\n").length).toBeGreaterThan(4);
  await page.request.post("/api/auth/demo", { data: { user: "admin" } });
  await page.goto("/audit");
  await page.getByLabel("시작일").fill("2099-01-01");
  await expect(
    page.getByText("조건에 맞는 감사 기록이 없습니다."),
  ).toBeVisible();
});
