import { expect, test, type Page } from "@playwright/test";
import { decodeJwt } from "jose";
import { TOTP } from "otpauth";
import postgres from "postgres";

const issuer = "http://127.0.0.1:3219";
const appUrl = "http://127.0.0.1:3218";
const targetId = "00000000-0000-4000-8000-000000000401";
const credentials = JSON.parse(
  process.env.TAXOPS_TEST_CREDENTIALS ?? "null",
) as {
  accounts: Record<string, { password: string; otpSecret: string }>;
};
const ownerUrl = new URL(
  process.env.TEST_DATABASE_OWNER_URL ?? "http://invalid",
);
if (
  process.env.TAXOPS_AUTH_TEST_RUN !== "1" ||
  ownerUrl.hostname !== "127.0.0.1" ||
  ownerUrl.port !== "55437" ||
  ownerUrl.pathname !== "/taxops_auth_test"
) {
  throw new Error(
    "Only the disposable local authentication database is allowed",
  );
}
const owner = postgres(ownerUrl.toString(), { max: 1, prepare: false });
const counters = new Map<string, number>();
test.afterAll(async () => {
  await owner.end({ timeout: 2 });
});

async function authenticate(page: Page, name: string) {
  const account = credentials.accounts[name]!;
  await expect(
    page.getByRole("heading", { name: "테스트 계정 로그인" }),
  ).toBeVisible();
  // Wait for the next time step when needed; the real provider rejects OTP reuse.
  await expect
    .poll(() => Math.floor(Date.now() / 30_000), {
      timeout: 35_000,
      intervals: [1000],
    })
    .toBeGreaterThan(counters.get(name) ?? -1);
  const counter = Math.floor(Date.now() / 30_000);
  await page.getByLabel("테스트 계정", { exact: true }).fill(name);
  await page.getByLabel("비밀번호", { exact: true }).fill(account.password);
  await page
    .getByLabel("인증번호", { exact: true })
    .fill(new TOTP({ secret: account.otpSecret }).generate());
  counters.set(name, counter);
  await page.getByRole("button", { name: "인증하기", exact: true }).click();
}

test("issuer discovery and public signing keys are served by the actual provider", async ({
  request,
}) => {
  const response = await request.get(
    `${issuer}/.well-known/openid-configuration`,
  );
  expect(response.status()).toBe(200);
  const discovery = await response.json();
  expect(discovery.issuer).toBe(issuer);
  expect(discovery.code_challenge_methods_supported).toContain("S256");
  const keys = await (await request.get(discovery.jwks_uri)).json();
  expect(keys.keys.length).toBeGreaterThan(0);
  expect(keys.keys.some((key: { d?: string }) => Boolean(key.d))).toBe(false);
  const invalidGrant = await request.post(`${issuer}/token`, {
    form: { grant_type: "authorization_code", code: "invalid" },
  });
  expect(invalidGrant.status()).toBeGreaterThanOrEqual(400);
});

test("password and OTP are enforced; API RBAC and database logout revocation work", async ({
  page,
  context,
}) => {
  await page.goto("/cases");
  await expect(
    page.getByRole("heading", { name: "테스트 계정 로그인" }),
  ).toBeVisible();
  await page.getByLabel("테스트 계정", { exact: true }).fill("analyst");
  await page.getByLabel("비밀번호", { exact: true }).fill("incorrect-password");
  await page.getByLabel("인증번호", { exact: true }).fill("000000");
  await page.getByRole("button", { name: "인증하기", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "계정 또는 비밀번호를 확인해 주세요.",
  );
  await page.getByLabel("테스트 계정", { exact: true }).fill("analyst");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(credentials.accounts.analyst!.password);
  await page.getByLabel("인증번호", { exact: true }).fill("invalid-otp");
  await page.getByRole("button", { name: "인증하기", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "인증번호가 유효하지 않거나 이미 사용되었습니다.",
  );
  await authenticate(page, "analyst");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/cases");
  const session = (await context.cookies()).find(
    (cookie) => cookie.name === "taxops_session",
  )!;
  expect(Boolean(session)).toBe(true);
  const binding = decodeJwt(session.value);
  const rows =
    await owner`select revoked_at from web_sessions where id=${binding.jti!}::uuid`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.revoked_at).toBeNull();
  expect((await page.request.get(`/api/v1/reviews/${targetId}`)).status()).toBe(
    403,
  );
  const invalidToken = await page.request.get(`/api/v1/reviews/${targetId}`, {
    headers: { authorization: "Bearer not-a-jwt" },
  });
  expect(invalidToken.status()).toBe(401);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "로그아웃되었습니다." }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(appUrl);
  const revoked =
    await owner`select revoked_at from web_sessions where id=${binding.jti!}::uuid`;
  expect(Boolean(revoked[0]!.revoked_at)).toBe(true);
  // Replay the old browser cookie to prove server-side revocation, not just cookie removal.
  await context.addCookies([session]);
  expect((await page.request.get(`/api/v1/reviews/${targetId}`)).status()).toBe(
    401,
  );
  await context.clearCookies();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "로그아웃되었습니다." }),
  ).toBeVisible();
});

test("cancelling at the real issuer returns to the public recovery page", async ({
  page,
  context,
}) => {
  await page.goto("/reviews");
  await page.getByRole("button", { name: "로그인 취소", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "로그인이 취소되었습니다." }),
  ).toBeVisible();
  expect(new URL(page.url()).origin).toBe(appUrl);
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "taxops_oidc_transaction",
    ),
  ).toBe(false);
  await expect(
    page.getByRole("link", { name: "로그인", exact: true }),
  ).toHaveAttribute("href", /returnTo=%2Freviews/);
});

test("a valid issuer account without an application membership is rejected", async ({
  page,
  context,
}) => {
  await page.goto("/cases");
  await authenticate(page, "outsider");
  await expect(
    page.getByRole("heading", { name: "로그인을 완료하지 못했습니다." }),
  ).toBeVisible();
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "taxops_session",
    ),
  ).toBe(false);
});

test("reauthentication cannot switch the existing user while a draft is open", async ({
  page,
  context,
}) => {
  await page.goto("/reviews");
  await authenticate(page, "reviewer");
  await expect(page.getByLabel("검토 의견")).toBeVisible();
  await page
    .getByLabel("검토 의견")
    .fill("다른 계정으로 전환해도 원래 검토 의견을 유지합니다.");
  const original = (await context.cookies()).find(
    (cookie) => cookie.name === "taxops_session",
  )!;
  const popup = await context.newPage();
  await popup.goto(
    `${appUrl}/api/auth/login?returnTo=%2Freviews&reauthenticate=1`,
  );
  await authenticate(popup, "analyst");
  await expect(
    popup.getByRole("heading", { name: "로그인을 완료하지 못했습니다." }),
  ).toBeVisible();
  const current = (await context.cookies()).find(
    (cookie) => cookie.name === "taxops_session",
  );
  expect(current?.value === original.value).toBe(true);
  await popup.close();
  await expect(page.getByLabel("검토 의견")).toHaveValue(
    "다른 계정으로 전환해도 원래 검토 의견을 유지합니다.",
  );
  expect((await page.request.get(`/api/v1/reviews/${targetId}`)).status()).toBe(
    200,
  );
});

test("expired reviewer cookie recovers through real MFA and persists exactly one explicit approval", async ({
  page,
  context,
}) => {
  await page.goto("/reviews");
  await authenticate(page, "reviewer");
  const note = "실제 인증기관 재인증 후 원문과 계산을 확인하여 승인합니다.";
  await page.getByLabel("검토 의견").fill(note);
  await expect(page.getByLabel("검토 의견")).toHaveValue(note);
  const approve = page.getByRole("button", { name: "승인", exact: true });
  await expect(approve).toBeEnabled();
  // Expire only the short-lived reviewer cookie; the real web session remains active.
  await context.clearCookies({ name: "taxops_review_access" });
  const [denied] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith(`/api/v1/reviews/${targetId}`),
      { timeout: 20_000 },
    ),
    approve.click(),
  ]);
  expect(denied.status()).toBe(401);
  const popupPromise = context.waitForEvent("page");
  await page.getByRole("link", { name: "다시 인증하기 (새 탭)" }).click();
  const popup = await popupPromise;
  await authenticate(popup, "reviewer");
  await expect(
    popup.getByRole("heading", { name: "인증이 갱신되었습니다." }),
  ).toBeVisible();
  await popup.close();
  await expect(page.getByLabel("검토 의견")).toHaveValue(note);
  const before =
    await owner`select status from approvals where target_id=${targetId}::uuid`;
  expect(before[0]!.status).toBe("PENDING");
  await page.getByRole("button", { name: "승인", exact: true }).click();
  await expect(page.getByText("검토조서를 승인했습니다.")).toBeVisible();
  const persisted =
    await owner`select status from approvals where target_id=${targetId}::uuid`;
  expect(persisted).toHaveLength(1);
  expect(persisted[0]!.status).toBe("APPROVED");
  await page.reload();
  expect((await page.request.get(`/api/v1/reviews/${targetId}`)).status()).toBe(
    200,
  );
});
