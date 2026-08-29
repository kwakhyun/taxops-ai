import postgres from "postgres";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { failureDisposition } from "../lib/jobs/retry-policy.ts";
import { fetchWithoutRedirect } from "../lib/security/safe-fetch.ts";
import { workerProductionConfigurationErrors } from "../lib/security/runtime-mode.ts";
import {
  LeaseLostError,
  type ClaimedJob,
  type ClaimedOutbox,
} from "./contracts.ts";
import { createDocumentIngestionService } from "./ingestion-service.ts";
import { getS3Client } from "./object-storage-client.ts";

const databaseUrl = process.env.DATABASE_URL;
const workerConfigurationErrors = workerProductionConfigurationErrors();
if (workerConfigurationErrors.length > 0) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.config_invalid",
      keys: workerConfigurationErrors,
    }),
  );
  process.exit(1);
}
if (!databaseUrl) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.config_missing",
      key: "DATABASE_URL",
    }),
  );
  process.exit(1);
}

const database = postgres(databaseUrl, { max: 4, prepare: false });
const workerId = `worker-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const notificationWebhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
const notificationWebhookSecret = process.env.NOTIFICATION_WEBHOOK_SECRET;
const notificationWebhookRequired =
  process.env.REQUIRE_NOTIFICATION_WEBHOOK === "true";
if (
  notificationWebhookRequired &&
  (!notificationWebhookUrl || !notificationWebhookSecret)
) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.config_missing",
      key: "NOTIFICATION_WEBHOOK_URL or NOTIFICATION_WEBHOOK_SECRET",
    }),
  );
  process.exit(1);
}
if (
  notificationWebhookUrl &&
  notificationWebhookRequired &&
  new URL(notificationWebhookUrl).protocol !== "https:"
) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.config_invalid",
      key: "NOTIFICATION_WEBHOOK_URL",
    }),
  );
  process.exit(1);
}
let stopping = false;
const heartbeatPath = "/tmp/taxops-worker-heartbeat";

async function verifyWorkerStartupDependencies() {
  if (process.env.NODE_ENV !== "production") return;
  await database`SELECT 1`;
  await getS3Client().send(
    new HeadBucketCommand({ Bucket: process.env.OBJECT_BUCKET! }),
  );
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect({
      host: process.env.CLAMAV_HOST!,
      port: Number(process.env.CLAMAV_PORT ?? 3310),
    });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("ClamAV startup probe timed out"));
    }, 5_000);
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      const value = chunk.toString("utf8").replace(/\0/g, "").trim();
      socket.destroy();
      resolve(value);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  if (response !== "PONG") {
    throw new Error("ClamAV startup probe returned an invalid response");
  }
}

async function claimJob() {
  const rows = await database<ClaimedJob[]>`
    SELECT * FROM claim_next_job(${workerId})
  `;
  return rows[0];
}

async function claimOutbox() {
  const rows = await database<ClaimedOutbox[]>`
    SELECT * FROM claim_next_outbox()
  `;
  return rows[0];
}

async function dispatchOutbox(event: ClaimedOutbox) {
  if (!notificationWebhookUrl || !notificationWebhookSecret) return;
  const body = JSON.stringify({
    id: event.id,
    topic: event.topic,
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    payload: event.payload,
    attempt: event.attempts,
  });
  const signature = createHmac("sha256", notificationWebhookSecret)
    .update(body)
    .digest("hex");
  try {
    const response = await fetchWithoutRedirect(notificationWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": event.idempotency_key,
        "X-TaxOps-Signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Notification webhook failed with ${response.status}`);
    }
    await database.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${event.tenant_id}, true)`;
      await transaction`
        UPDATE outbox_events
        SET published_at = now(), last_error_code = NULL
        WHERE id = ${event.id} AND tenant_id = ${event.tenant_id}
          AND published_at IS NULL
      `;
    });
  } catch (error) {
    const errorCode =
      error instanceof Error ? error.name.slice(0, 80) : "UNKNOWN";
    await database.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${event.tenant_id}, true)`;
      await transaction`
        UPDATE outbox_events
        SET last_error_code = ${errorCode}
        WHERE id = ${event.id} AND tenant_id = ${event.tenant_id}
          AND published_at IS NULL
      `;
    });
    throw error;
  }
}

async function updateProgress(
  job: ClaimedJob,
  progress: number,
  leaseSeconds = 90,
) {
  await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    const rows = await transaction<{ id: string }[]>`
      UPDATE jobs
      SET progress = ${progress},
          lease_expires_at = now() + (${leaseSeconds} * interval '1 second'),
          updated_at = now()
      WHERE id = ${job.id} AND tenant_id = ${job.tenant_id}
        AND lease_owner = ${workerId} AND status = 'RUNNING'
      RETURNING id::text
    `;
    if (!rows[0]) throw new LeaseLostError();
  });
}

const { processDocument, tagObject } = createDocumentIngestionService({
  database,
  workerId,
  updateProgress,
});

async function completeJob(job: ClaimedJob) {
  await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    const rows = await transaction<{ id: string }[]>`
      UPDATE jobs
      SET status = 'SUCCEEDED', progress = 100, completed_at = now(),
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${job.id} AND tenant_id = ${job.tenant_id} AND lease_owner = ${workerId}
      RETURNING id::text
    `;
    if (!rows[0]) throw new LeaseLostError();
  });
}

async function failJob(job: ClaimedJob, error: unknown) {
  const permanent =
    error instanceof Error && "permanent" in error && error.permanent === true;
  const { status, delaySeconds } = failureDisposition({
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    permanent,
  });
  const errorCode =
    error instanceof Error ? error.name.slice(0, 80) : "UNKNOWN";
  await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    const rows = await transaction<{ id: string }[]>`
      UPDATE jobs
      SET status = ${status}, last_error_code = ${errorCode},
          available_at = now() + (${delaySeconds} * interval '1 second'),
          lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = ${job.id} AND tenant_id = ${job.tenant_id} AND lease_owner = ${workerId}
      RETURNING id::text
    `;
    if (
      rows[0] &&
      status === "DEAD" &&
      typeof job.payload.documentId === "string"
    ) {
      await transaction`
        UPDATE documents
        SET status = 'FAILED', updated_at = now()
        WHERE id = ${job.payload.documentId} AND tenant_id = ${job.tenant_id}
          AND evidence_status = 'PENDING'
          AND status IN ('QUARANTINED', 'SCANNING', 'PARSING')
      `;
    }
  });
  if (
    status === "DEAD" &&
    error instanceof Error &&
    "cleanObject" in error &&
    error.cleanObject &&
    typeof error.cleanObject === "object" &&
    "uri" in error.cleanObject &&
    "versionId" in error.cleanObject &&
    typeof error.cleanObject.uri === "string" &&
    typeof error.cleanObject.versionId === "string"
  ) {
    try {
      await tagObject(
        error.cleanObject.uri,
        error.cleanObject.versionId,
        "failed",
      );
    } catch (tagError) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "object.failed_retention_tag_failed",
          jobId: job.id,
          errorCode: tagError instanceof Error ? tagError.name : "UNKNOWN",
        }),
      );
    }
  }
}

async function emitOperationalMetrics() {
  const rows = await database<
    Array<{
      queue_oldest_seconds: string;
      dead_jobs: string;
      stuck_outbox: string;
    }>
  >`SELECT * FROM worker_operational_metrics()`;
  const metrics = rows[0];
  if (!metrics) return;
  console.info(
    JSON.stringify({
      level: "info",
      event: "worker.operational_metrics",
      queueOldestSeconds: Number(metrics.queue_oldest_seconds),
      deadJobs: Number(metrics.dead_jobs),
      stuckOutbox: Number(metrics.stuck_outbox),
    }),
  );
}

async function run() {
  await verifyWorkerStartupDependencies();
  console.info(
    JSON.stringify({ level: "info", event: "worker.started", workerId }),
  );
  const touchHeartbeat = () =>
    writeFile(heartbeatPath, new Date().toISOString(), { mode: 0o600 }).catch(
      (error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "worker.heartbeat_failed",
            workerId,
            errorCode: error instanceof Error ? error.name : "UNKNOWN",
          }),
        );
      },
    );
  await touchHeartbeat();
  const heartbeat = setInterval(() => void touchHeartbeat(), 15_000);
  heartbeat.unref();
  let nextMetricsAt = 0;
  while (!stopping) {
    if (Date.now() >= nextMetricsAt) {
      nextMetricsAt = Date.now() + 60_000;
      await emitOperationalMetrics().catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "worker.metrics_failed",
            errorCode: error instanceof Error ? error.name : "UNKNOWN",
          }),
        );
      });
    }
    const outbox =
      notificationWebhookUrl && notificationWebhookSecret
        ? await claimOutbox()
        : undefined;
    if (outbox) {
      try {
        await dispatchOutbox(outbox);
      } catch {
        console.error(
          JSON.stringify({
            level: "error",
            event: "outbox.delivery_failed",
            outboxId: outbox.id,
            workerId,
          }),
        );
      }
      continue;
    }
    const job = await claimJob();
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    try {
      if (job.attempts > job.max_attempts) {
        throw Object.assign(new Error("Job retry budget exhausted"), {
          permanent: true,
        });
      }
      if (job.type === "DOCUMENT_INGESTION") await processDocument(job);
      else
        throw Object.assign(new Error("Unsupported job type"), {
          permanent: true,
        });
      await completeJob(job);
      console.info(
        JSON.stringify({
          level: "info",
          event: "job.completed",
          jobId: job.id,
          workerId,
        }),
      );
    } catch (error) {
      await failJob(job, error);
      console.error(
        JSON.stringify({
          level: "error",
          event: "job.failed",
          jobId: job.id,
          workerId,
        }),
      );
    }
  }
  clearInterval(heartbeat);
  await database.end({ timeout: 5 });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

export async function startWorker() {
  try {
    await run();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "worker.startup_failed",
        error:
          error instanceof Error
            ? error.message
            : "Unknown worker startup error",
      }),
    );
    await database.end({ timeout: 5 }).catch(() => undefined);
    process.exitCode = 1;
  }
}
