import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

const rawDirectory = resolve("artifacts/portfolio/raw");
type Cue = { atMs: number; title: string; description: string };

async function record(
  browser: Browser,
  baseURL: string,
  name: string,
  viewport: { width: number; height: number },
  steps: (
    page: Page,
    cue: (title: string, description: string) => void,
  ) => Promise<void>,
) {
  if (baseURL !== "http://127.0.0.1:3300")
    throw new Error("Recording is local-only.");
  await mkdir(rawDirectory, { recursive: true });
  const context = await browser.newContext({
    baseURL,
    viewport,
    reducedMotion: "reduce",
    recordVideo: { dir: rawDirectory, size: viewport },
  });
  expect((await context.request.post("/api/test/reset")).ok()).toBe(true);
  expect(
    (
      await context.request.post("/api/auth/demo", {
        data: { user: "analyst" },
      })
    ).ok(),
  ).toBe(true);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) =>
    errors.push(error.name + ": " + error.message),
  );
  const started = performance.now();
  const cues: Cue[] = [];
  const cue = (title: string, description: string) =>
    cues.push({
      atMs: Math.round(performance.now() - started),
      title,
      description,
    });
  let completed = false;
  try {
    await steps(page, cue);
    expect(errors).toEqual([]);
    completed = true;
  } finally {
    const video = page.video();
    await context.close();
    await video?.saveAs(resolve(rawDirectory, `${name}.webm`));
    await writeFile(
      resolve(rawDirectory, `${name}.json`),
      JSON.stringify(
        { name, viewport, completed, cues, pageErrors: errors },
        null,
        2,
      ) + "\n",
    );
  }
}

// These pauses are reading time for the recording, never readiness assertions.
const readFor = (milliseconds = 4000) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("record analyst, reviewer approval and audit trail", async ({
  browser,
  baseURL,
}) => {
  await record(
    browser,
    baseURL!,
    "desktop",
    { width: 1280, height: 800 },
    async (page, cue) => {
      cue(
        "01  실무자 | 오늘 처리할 업무",
        "예시 데이터로 재현한 실제 UI입니다. 실제 고객자료나 세무 신고는 사용하지 않습니다.",
      );
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "오늘 처리할 세무 업무" }),
      ).toBeVisible();
      await expect(
        page.getByText("세무 실무자", { exact: true }),
      ).toBeVisible();
      await readFor(5000);

      cue(
        "02  업무 개요 | 고객사와 신고 기간",
        "자료 수집부터 검토와 승인, 신고 전 점검까지 같은 업무 안에서 확인합니다.",
      );
      await page.goto("/cases/vat-2025-q4");
      await expect(
        page.getByRole("heading", { name: "한빛테크 주식회사", exact: true }),
      ).toBeVisible();
      await readFor(5500);

      cue(
        "03  자료 수집 | 파일을 처리 대기열에 등록",
        "첨부 성공은 처리 완료가 아닙니다. 검역과 근거 사용 승인을 거친 자료만 검색됩니다.",
      );
      await page.getByRole("link", { name: "자료 추가", exact: true }).click();
      await expect(
        page.getByText("2025_2기_매입매출장.xlsx", { exact: true }),
      ).toBeVisible();
      await readFor(2500);
      await page.getByLabel("업로드할 세무 자료 선택").setInputFiles({
        name: "portfolio-review-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "시연용 합성 자료입니다. 기업업무추진비 거래의 지출 목적을 확인합니다.",
        ),
      });
      await expect(page.getByRole("status")).toContainText(
        "대기열에 추가됐습니다.",
      );
      await readFor(4500);

      cue(
        "04  AI 파트너 | 주장과 원문 근거 확인",
        "공개 데모는 결정론적 AI 흐름입니다. 실제 모델의 지연 시간과 비용은 별도 평가로 측정합니다.",
      );
      await page.goto("/assistant?matter=vat-2025-q4");
      await readFor(2000);
      await page
        .getByRole("button", {
          name: /매입세액 불공제 의심 항목과 신고서 반영 차이/,
        })
        .click();
      await expect(page.getByRole("log")).toContainText("검토 결론");
      await expect(
        page.getByRole("button", { name: "다시 생성" }),
      ).toBeEnabled();
      await expect(page.locator(".assistant-evidence-panel")).toContainText(
        "분석 항목 6개 중 6개 근거 확인",
      );
      await readFor(7000);

      cue(
        "05  역할 전환 | 세무 검토자",
        "시연용 검토자 계정으로 전환합니다. 다음 조서는 미리 등록한 예시이며, 방금 대화의 자동 저장본이 아닙니다.",
      );
      expect(
        (
          await page.request.post("/api/auth/demo", {
            data: { user: "reviewer" },
          })
        ).ok(),
      ).toBe(true);
      await page.goto("/reviews");
      await expect(
        page.getByText("세무 검토자", { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".review-document-header")).toContainText(
        "검토 대기",
      );
      await readFor(6500);

      cue(
        "06  검토 | 고정된 버전, 계산과 근거",
        "검토조서의 내용 해시와 원문을 확인합니다. 승인 의견은 감사 이력에 남습니다.",
      );
      await page
        .getByRole("heading", { name: "근거와 확인 사항" })
        .scrollIntoViewIfNeeded();
      await readFor(5000);
      await page.getByLabel("검토 의견").scrollIntoViewIfNeeded();
      await page
        .getByLabel("검토 의견")
        .fill(
          "시연용 조서의 원문 근거와 계산을 확인하여 승인합니다. 실제 세무 신고에는 사용하지 않습니다.",
        );
      await readFor(3000);

      cue(
        "07  승인 완료 | 상태가 실제로 변경되는지 확인",
        "승인 후 다시 열어도 완료 상태가 유지됩니다. 데모 저장소는 서버 재시작 시 초기화됩니다.",
      );
      await page.getByRole("button", { name: "승인", exact: true }).click();
      await expect(page.getByRole("status")).toContainText(
        "검토조서를 승인했습니다.",
      );
      await readFor(3000);
      await page.reload();
      await expect(page.locator(".review-document-header")).toContainText(
        "승인 완료",
      );
      await expect(
        page.getByRole("button", { name: "승인", exact: true }),
      ).toBeHidden();
      await page.locator(".review-document-header").scrollIntoViewIfNeeded();
      await readFor(5000);

      cue(
        "08  감사 로그 | 누가 무엇을 승인했는지 추적",
        "역할 전환은 테스트용 인증입니다. 실제 OIDC 로그인과 운영 감사 저장소를 시연한 영상은 아닙니다.",
      );
      await page.goto("/audit");
      await expect(
        page.getByRole("heading", { name: "감사 로그", exact: true }),
      ).toBeVisible();
      await readFor(5000);
    },
  );
});

test("record mobile question, evidence, attachment and abstention", async ({
  browser,
  baseURL,
}) => {
  await record(
    browser,
    baseURL!,
    "mobile",
    { width: 390, height: 650 },
    async (page, cue) => {
      cue(
        "09  모바일 | 390 × 650 화면",
        "Chromium의 반응형 화면입니다. 실제 휴대전화나 가상 키보드를 촬영한 것은 아닙니다.",
      );
      await page.goto("/assistant?matter=vat-2025-q4");
      await expect(page.getByLabel("AI에게 질문")).toBeInViewport({ ratio: 1 });
      await readFor(4500);

      cue(
        "10  대화 | 입력창을 유지한 채 분석",
        "대화와 참고 근거를 분리해 좁은 화면에서도 입력과 확인 동작을 이어갑니다.",
      );
      await page
        .getByRole("button", { name: /매입세액 불공제 의심 항목/ })
        .click();
      await expect(
        page.getByRole("button", { name: "다시 생성" }),
      ).toBeEnabled();
      await expect(page.getByRole("log")).toContainText("검토 결론");
      await readFor(4000);

      cue(
        "11  참고 근거 | 작성 중인 질문 보존",
        "탭을 전환해도 추가 질문 초안이 사라지지 않습니다.",
      );
      await page
        .getByLabel("AI에게 질문")
        .fill("업무 관련성 메모가 없는 거래를 다시 확인해 주세요.");
      await page.getByRole("tab", { name: /참고 근거/ }).click();
      await expect(
        page.getByRole("complementary", { name: "응답 참고 근거" }),
      ).toContainText("분석 항목 6개 중 6개 근거 확인");
      await readFor(4500);
      await page.getByRole("tab", { name: "대화", exact: true }).click();
      await expect(page.getByLabel("AI에게 질문")).toHaveValue(
        "업무 관련성 메모가 없는 거래를 다시 확인해 주세요.",
      );
      await readFor(2500);

      cue(
        "12  자료 첨부 | 대화를 떠나지 않고 추가",
        "현재 업무에 합성 메모를 등록하고, 대화와 입력 내용을 그대로 유지합니다.",
      );
      await page
        .getByRole("button", { name: "자료 첨부", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "현재 업무에 자료 추가",
      });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("업로드할 세무 자료 선택").setInputFiles({
        name: "portfolio-mobile-note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("시연용 합성 자료: 거래 목적 확인 메모입니다."),
      });
      await expect(dialog.getByRole("status")).toContainText(
        "대기열에 추가됐습니다.",
      );
      await readFor(4500);
      await dialog.getByRole("button", { name: "자료 첨부 닫기" }).click();
      await expect(page.getByLabel("AI에게 질문")).toHaveValue(
        "업무 관련성 메모가 없는 거래를 다시 확인해 주세요.",
      );

      cue(
        "13  근거 부족 | 답변 보류와 다음 행동 안내",
        "현재 자료로 확인할 수 없는 질문에는 결론을 만들지 않고 필요한 자료를 안내합니다.",
      );
      await page.getByLabel("AI에게 질문").fill("상속세가업승계 요건을 알려줘");
      await page.getByRole("button", { name: "질문 보내기" }).click();
      await expect(page.getByRole("log")).toContainText("답변을 보류합니다");
      await expect(
        page.getByRole("button", { name: "다시 생성" }),
      ).toBeEnabled();
      await expect(page.getByLabel("AI에게 질문")).toBeInViewport({ ratio: 1 });
      await readFor(6000);
    },
  );
});
