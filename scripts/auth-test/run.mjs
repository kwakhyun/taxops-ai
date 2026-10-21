import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { cpus, loadavg, platform } from "node:os";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Secret } from "otpauth";
import { startTestIdentityProvider } from "./provider.mjs";

if (process.env.NODE_ENV === "production")
  throw new Error("Auth verification cannot run in production");
if (platform() === "darwin" && loadavg()[0] > cpus().length * 2)
  throw new Error(
    "Mac system load is too high; close other heavy tasks before retrying",
  );
process.env.TAXOPS_AUTH_TEST_RUN = "1";
const project = `taxops-auth-test-${randomBytes(3).toString("hex")}`;
const composeCommand =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0
    ? ["docker", "compose"]
    : ["docker-compose"];
const composeArgs = ["-f", "compose.auth-test.yaml", "-p", project];
const appUrl = "http://127.0.0.1:3218";
const issuer = "http://127.0.0.1:3219";
const reviewerUrl = "http://127.0.0.1:3220";
const database = "taxops_auth_test";
const ownerUrl = `postgres://taxops_owner:taxops_auth_test_only@127.0.0.1:55437/${database}`;
const accounts = Object.fromEntries(
  ["analyst", "reviewer", "outsider"].map((name) => [
    name,
    {
      password: randomBytes(24).toString("base64url"),
      otpSecret: new Secret({ size: 20 }).base32,
    },
  ]),
);
const clientSecret = randomBytes(32).toString("base64url");
const credentials = { accounts };
const children = [];
const logs = [];
let identityProvider;
let owner;
let databaseStarted = false;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
  });
}
const redact = (input) => {
  let text = input
    .replace(/(\/api\/auth\/callback|\/auth|\/token)\?[^\s]+/g, "$1?[REDACTED]")
    .replace(/[\w-]{15,}\.[\w-]{15,}\.[\w-]{15,}/g, "[JWT REDACTED]");
  for (const secret of [
    clientSecret,
    ...Object.values(accounts).flatMap((a) => [a.password, a.otpSecret]),
  ])
    text = text.replaceAll(secret, "[REDACTED]");
  return text;
};
function run(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.on("error", (error) => {
    logs.push(redact(error.message));
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      const line = redact(chunk.toString());
      logs.push(line);
      if (logs.length > 100) logs.shift();
      if (options.echo) process.stdout.write(line);
    });
  return child;
}
async function completed(child) {
  const [code] = await once(child, "exit");
  assert.equal(code, 0, "Verification subprocess failed");
}
async function waitFor(url, child, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error("Auth verification interrupted");
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error("Service stopped during startup");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* Retry startup only. */
    }
    await delay(750);
  }
  throw new Error(`Service readiness timed out: ${new URL(url).pathname}`);
}
async function assertPortAvailable(port) {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => socket.close(resolve));
}
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}
try {
  for (const port of [3218, 3219, 3220, 55437]) await assertPortAvailable(port);
  console.log(
    "[auth-test] Starting an ephemeral, resource-limited PostgreSQL database",
  );
  databaseStarted = true;
  await completed(
    run(composeCommand[0], [
      ...composeCommand.slice(1),
      ...composeArgs,
      "up",
      "-d",
      "--wait",
      "db",
    ]),
  );
  owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
  assert.equal(
    (await owner`select current_database() as name`)[0].name,
    database,
  );
  await owner.unsafe(await readFile("infra/docker/init/001-roles.sql", "utf8"));
  await migrate(drizzle(owner), { migrationsFolder: "drizzle" });
  await owner.unsafe(await readFile("drizzle/seed.sql", "utf8"));
  logs.length = 0; // Image-download progress is not useful for authentication failures.
  console.log(
    "[auth-test] Database roles, migrations and synthetic fixtures ready",
  );
  identityProvider = await startTestIdentityProvider({
    issuer,
    appUrl,
    clientId: "taxops-auth-test",
    clientSecret,
    audience: "urn:taxops:review",
    tenantId: "00000000-0000-4000-8000-000000000001",
    accounts,
  });
  const common = {
    ...process.env,
    NODE_ENV: "development",
    TAXOPS_AUTH_TEST_RUN: "1",
    NODE_OPTIONS: "--max-old-space-size=1536",
    RAYON_NUM_THREADS: "1",
    UV_THREADPOOL_SIZE: "2",
    AUTH_MODE: "oidc",
    PORTFOLIO_DEMO: "false",
    E2E_RESET_ENABLED: "false",
    APP_BASE_URL: appUrl,
    SESSION_SECRET: randomBytes(32).toString("base64url"),
    APPROVAL_TOKEN_SECRET: randomBytes(32).toString("base64url"),
    OIDC_ISSUER: issuer,
    OIDC_JWKS_URL: `${issuer}/jwks`,
    OIDC_AUTHORIZATION_URL: `${issuer}/auth`,
    OIDC_TOKEN_URL: `${issuer}/token`,
    OIDC_CLIENT_ID: "taxops-auth-test",
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_AUDIENCE: "urn:taxops:review",
    OIDC_REVIEW_AUDIENCE: "urn:taxops:review",
    OIDC_REVIEW_RESOURCE_PARAMETER: "resource",
    OIDC_REVIEW_SCOPE: "review:decide",
    OIDC_REVIEW_REQUIRED_ACR: "urn:taxops:acr:mfa",
    REVIEW_SERVICE_URL: reviewerUrl,
    REVIEW_SERVICE_ALLOWED_HOST: "127.0.0.1",
    REVIEW_SERVICE_SHARED_SECRET: randomBytes(32).toString("base64url"),
    AI_GATEWAY_API_KEY: "",
    OPENAI_API_KEY: "",
    OBJECT_BUCKET: "",
    DATABASE_URL: "",
    REVIEW_DATABASE_URL: "",
    NEXT_TELEMETRY_DISABLED: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
  };
  const reviewer = run(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import { startReviewer } from './src/reviewer/server.ts'; startReviewer('127.0.0.1');",
    ],
    {
      env: {
        ...common,
        NODE_OPTIONS: "--max-old-space-size=384",
        PORT: "3220",
        REVIEW_DATABASE_URL: `postgres://taxops_reviewer:taxops_reviewer_dev_only@127.0.0.1:55437/${database}`,
      },
    },
  );
  await waitFor(`${reviewerUrl}/health`, reviewer, 30_000);
  const web = run(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3218",
    ],
    {
      env: {
        ...common,
        DATABASE_URL: `postgres://taxops_app:taxops_app_dev_only@127.0.0.1:55437/${database}`,
      },
    },
  );
  await waitFor(`${appUrl}/api/health/live`, web);
  // Warm only the public status page before starting the single browser worker.
  await waitFor(`${appUrl}/auth/status`, web);
  console.log(
    "[auth-test] OIDC issuer, isolated reviewer and web ready; running one browser worker",
  );
  await completed(
    run(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "playwright.auth.config.ts",
      ],
      {
        env: {
          ...common,
          TAXOPS_TEST_CREDENTIALS: JSON.stringify(credentials),
          TEST_DATABASE_OWNER_URL: ownerUrl,
        },
        echo: true,
      },
    ),
  );
  assert.ok(identityProvider.metrics.authenticated >= 5);
  assert.ok(identityProvider.metrics.passwordDenied >= 1);
  assert.ok(identityProvider.metrics.otpDenied >= 1);
  assert.equal(
    identityProvider.metrics.codeExchanges,
    identityProvider.metrics.pkceExchanges,
  );
  assert.ok(identityProvider.metrics.codeExchanges >= 5);
  const sessionRows =
    await owner`select count(*)::int as total, count(revoked_at)::int as revoked from web_sessions`;
  const approvals =
    await owner`select status from approvals where id='00000000-0000-4000-8000-000000000403'`;
  assert.ok(sessionRows[0].revoked >= 1);
  assert.equal(approvals[0].status, "APPROVED");
  await mkdir("artifacts/auth-test", { recursive: true });
  await writeFile(
    "artifacts/auth-test/verification.json",
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        provider: "oidc-provider@9.12.2",
        environment: "isolated-loopback",
        protocolMocking: false,
        providerMetrics: identityProvider.metrics,
        sessions: sessionRows[0],
        approval: approvals[0].status,
        limitations: [
          "Not an organization-managed SaaS identity provider",
          "Loopback HTTP in development; production TLS and organization enrollment are not certified",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "[auth-test] PASS: actual OIDC + password/OTP + PostgreSQL session revocation + reviewer approval",
  );
} catch (error) {
  console.error(logs.join("\n"));
  console.error(
    redact(error instanceof Error ? error.message : "Auth verification failed"),
  );
  process.exitCode = 1;
} finally {
  for (const child of children.toReversed()) await stopChild(child);
  await identityProvider?.close();
  await owner?.end({ timeout: 3 });
  if (databaseStarted && /^taxops-auth-test-[a-f0-9]{6}$/.test(project)) {
    // Only this invocation's disposable container/network; no persistent volume is created.
    const cleanup = spawn(
      composeCommand[0],
      [...composeCommand.slice(1), ...composeArgs, "down", "--timeout", "5"],
      { stdio: "ignore" },
    );
    const [code] = await once(cleanup, "exit");
    if (code !== 0) {
      console.error(`[auth-test] Cleanup required for ${project}`);
      process.exitCode = 1;
    }
  }
}
