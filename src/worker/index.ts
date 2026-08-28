import postgres from "postgres";
import { createHash, createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { connect } from "node:net";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { embedMany } from "ai";
import { failureDisposition } from "../lib/jobs/retry-policy.ts";
import {
  AiPolicyError,
  protectAiOutboundBatch,
  resolveTenantAiPolicy,
  type TenantAiPolicy,
} from "../lib/security/ai-policy.ts";
import { chunkPlainText, type ParsedChunk } from "../lib/files/chunking.ts";
import {
  readBoundedProcessorResponse,
  verifyProcessorResponse,
} from "../lib/files/document-processor-contract.ts";
import { evidenceManifestHash } from "../lib/documents/evidence-manifest.ts";
import { validateRegionalServiceEndpoint } from "../lib/security/regional-service.ts";
import { fetchWithoutRedirect } from "../lib/security/safe-fetch.ts";
import { detectUntrustedSourceInstruction } from "../lib/ai/guardrails.ts";
import {
  classifyProtectedUntrustedSourceBatch,
  type InjectionClassification,
} from "../lib/security/injection-classifier.ts";
import { workerProductionConfigurationErrors } from "../lib/security/runtime-mode.ts";

type ClaimedJob = {
  id: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

type ClaimedOutbox = {
  id: string;
  tenant_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
};

type SourceDocument = {
  id: string;
  object_key: string;
  object_version_id: string | null;
  object_etag: string | null;
  object_checksum_sha256: string | null;
  original_name: string;
  mime_type: string;
  checksum_sha256: string;
  version: number;
  source_type: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  source_publisher: string | null;
  source_uri: string | null;
  acquired_at: Date | null;
  evidence_status: "PENDING" | "APPROVED" | "REJECTED";
};

class LeaseLostError extends Error {
  constructor() {
    super("Job lease is no longer owned by this worker");
    this.name = "LeaseLostError";
  }
}

class MalwareDetectedError extends Error {
  readonly permanent = true;

  constructor() {
    super("Malware scan rejected the document");
    this.name = "MALWARE_DETECTED";
  }
}

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
let s3Client: S3Client | undefined;
const heartbeatPath = "/tmp/taxops-worker-heartbeat";

function getS3Client() {
  s3Client ??= new S3Client({
    region: process.env.AWS_REGION ?? "ap-northeast-2",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
  return s3Client;
}

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

async function getSourceDocument(job: ClaimedJob, documentId: string) {
  return database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    const rows = await transaction<SourceDocument[]>`
      SELECT id::text, object_key, object_version_id, object_etag,
             object_checksum_sha256, original_name, mime_type,
             checksum_sha256, version,
             source_type, source_publisher, source_uri, acquired_at,
             evidence_status
      FROM documents
      WHERE id = ${documentId} AND tenant_id = ${job.tenant_id}
      LIMIT 1
    `;
    return rows[0];
  });
}

function parseS3Uri(uri: string) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match?.[1] || !match[2]) {
    throw Object.assign(new Error("Document object key is not an S3 URI"), {
      permanent: true,
    });
  }
  if (process.env.OBJECT_BUCKET && match[1] !== process.env.OBJECT_BUCKET) {
    throw Object.assign(
      new Error("Document object points outside the configured bucket"),
      { permanent: true },
    );
  }
  return { bucket: match[1], key: match[2] };
}

async function downloadObject(document: SourceDocument) {
  if (
    !document.object_version_id ||
    !document.object_etag ||
    !document.object_checksum_sha256
  ) {
    throw Object.assign(
      new Error("Document is missing an immutable object version binding"),
      { permanent: true },
    );
  }
  if (document.object_checksum_sha256 !== document.checksum_sha256) {
    throw Object.assign(
      new Error("Object binding checksum differs from the document checksum"),
      { permanent: true },
    );
  }
  const uri = document.object_key;
  const { bucket, key } = parseS3Uri(uri);
  const result = await getS3Client().send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: document.object_version_id,
      ChecksumMode: "ENABLED",
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!result.Body) throw new Error("Object storage returned an empty body");
  const bytes = await result.Body.transformToByteArray();
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) {
    throw Object.assign(
      new Error("Stored object size is outside the allowed range"),
      {
        permanent: true,
      },
    );
  }
  if (!result.VersionId || !result.ETag || !result.ChecksumSHA256) {
    throw Object.assign(
      new Error(
        "Stored object is missing an immutable version or SHA-256 checksum",
      ),
      { permanent: true },
    );
  }
  const expectedChecksum = Buffer.from(
    document.object_checksum_sha256,
    "hex",
  ).toString("base64");
  if (
    result.VersionId !== document.object_version_id ||
    result.ETag !== document.object_etag ||
    result.ChecksumSHA256 !== expectedChecksum
  ) {
    throw Object.assign(
      new Error("Stored object metadata differs from its immutable binding"),
      { permanent: true },
    );
  }
  return {
    bytes,
    versionId: result.VersionId,
    etag: result.ETag,
    checksumSha256: result.ChecksumSHA256,
  };
}

function encodedCopySource(bucket: string, key: string, versionId: string) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${bucket}/${encodedKey}?versionId=${encodeURIComponent(versionId)}`;
}

function cleanObjectKey(key: string) {
  if (key.includes("/clean/")) return key;
  if (!key.includes("/quarantine/")) {
    throw Object.assign(
      new Error("Document is outside a managed object tier"),
      {
        permanent: true,
      },
    );
  }
  return key.replace("/quarantine/", "/clean/");
}

async function tagObject(
  uri: string,
  versionId: string,
  lifecycle: "failed" | "malware" | "quarantine",
) {
  const { bucket, key } = parseS3Uri(uri);
  await getS3Client().send(
    new PutObjectTaggingCommand({
      Bucket: bucket,
      Key: key,
      VersionId: versionId,
      Tagging: { TagSet: [{ Key: "lifecycle", Value: lifecycle }] },
    }),
  );
}

async function promoteCleanObject(
  tenantId: string,
  document: SourceDocument,
  sourceObject: Awaited<ReturnType<typeof downloadObject>>,
) {
  const source = parseS3Uri(document.object_key);
  const targetKey = cleanObjectKey(source.key);
  if (targetKey === source.key) {
    return {
      uri: document.object_key,
      versionId: sourceObject.versionId,
      etag: sourceObject.etag,
      checksumSha256: document.checksum_sha256,
    };
  }
  const encryption = process.env.S3_ENDPOINT
    ? undefined
    : process.env.S3_KMS_KEY_ID
      ? "aws:kms"
      : "AES256";
  const copy = await getS3Client().send(
    new CopyObjectCommand({
      Bucket: source.bucket,
      Key: targetKey,
      CopySource: encodedCopySource(
        source.bucket,
        source.key,
        sourceObject.versionId,
      ),
      CopySourceIfMatch: sourceObject.etag,
      ChecksumAlgorithm: "SHA256",
      MetadataDirective: "COPY",
      TaggingDirective: "REPLACE",
      Tagging: "lifecycle=clean",
      ServerSideEncryption: encryption,
      SSEKMSKeyId: process.env.S3_KMS_KEY_ID,
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  if (!copy.VersionId) {
    throw Object.assign(
      new Error("Clean object copy did not return a destination version"),
      { permanent: true },
    );
  }
  const cleanVersionId = copy.VersionId;
  const head = await getS3Client().send(
    new HeadObjectCommand({
      Bucket: source.bucket,
      Key: targetKey,
      VersionId: cleanVersionId,
      ChecksumMode: "ENABLED",
    }),
    { abortSignal: AbortSignal.timeout(10_000) },
  );
  const expectedChecksum = Buffer.from(
    document.checksum_sha256,
    "hex",
  ).toString("base64");
  if (
    !head.ETag ||
    Number(head.ContentLength) !== sourceObject.bytes.length ||
    sourceObject.checksumSha256 !== expectedChecksum ||
    head.ChecksumSHA256 !== expectedChecksum
  ) {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: source.bucket,
        Key: targetKey,
        VersionId: cleanVersionId,
      }),
    );
    throw Object.assign(
      new Error("Clean object copy failed checksum metadata verification"),
      { permanent: true },
    );
  }
  const cleanEtag = head.ETag;
  const targetUri = `s3://${source.bucket}/${targetKey}`;
  const updated = await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return await transaction<{ id: string }[]>`
      UPDATE documents
      SET object_key = ${targetUri}, object_version_id = ${cleanVersionId},
          object_etag = ${cleanEtag},
          object_checksum_sha256 = ${document.checksum_sha256},
          updated_at = now()
      WHERE id = ${document.id}
        AND version = ${document.version}
        AND object_key = ${document.object_key}
        AND object_version_id = ${document.object_version_id}
        AND object_etag = ${document.object_etag}
        AND object_checksum_sha256 = ${document.object_checksum_sha256}
        AND status = 'SCANNING'
        AND evidence_status = 'PENDING'
      RETURNING id::text
    `;
  });
  if (!updated[0]) {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: source.bucket,
        Key: targetKey,
        VersionId: cleanVersionId,
      }),
    );
    throw new LeaseLostError();
  }
  try {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: source.bucket,
        Key: source.key,
        VersionId: sourceObject.versionId,
      }),
    );
  } catch (error) {
    // Promotion is already committed and the immutable clean version is the
    // source of truth. The quarantine lifecycle is the bounded cleanup retry.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "object.quarantine_cleanup_deferred",
        documentId: document.id,
        sourceVersionId: sourceObject.versionId,
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
      }),
    );
  }
  return {
    uri: targetUri,
    versionId: cleanVersionId,
    etag: cleanEtag,
    checksumSha256: document.checksum_sha256,
  };
}

async function scanWithClamAv(bytes: Uint8Array) {
  const host = process.env.CLAMAV_HOST;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  if (!host) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("CLAMAV_HOST is required in production"), {
        permanent: true,
      });
    }
    return;
  }

  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    const responseChunks: Buffer[] = [];
    const timeout = setTimeout(
      () => socket.destroy(new Error("ClamAV scan timed out")),
      15_000,
    );
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.slice(
          offset,
          Math.min(offset + 64 * 1024, bytes.length),
        );
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
    socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(
        Buffer.concat(responseChunks)
          .toString("utf8")
          .replace(/\0/g, "")
          .trim(),
      );
    });
  });
  if (!response.endsWith("OK")) {
    throw new MalwareDetectedError();
  }
}

async function parseDocument(
  document: SourceDocument,
  bytes: Uint8Array,
  policy: TenantAiPolicy,
) {
  if (
    document.source_type === "BUSINESS_RECORD" &&
    (document.mime_type === "text/plain" || document.mime_type === "text/csv")
  ) {
    return chunkPlainText(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).map((chunk) => ({
      ...chunk,
      sourceType: document.source_type,
      jurisdiction: "KR",
    }));
  }

  const processorUrl = process.env.DOCUMENT_PROCESSOR_URL;
  if (!processorUrl) {
    throw Object.assign(
      new Error("DOCUMENT_PROCESSOR_URL is required for this file type"),
      {
        permanent: true,
      },
    );
  }
  const url = validateRegionalServiceEndpoint({
    serviceName: "Document processor",
    url: processorUrl,
    token: process.env.DOCUMENT_PROCESSOR_TOKEN,
    dataRegion: process.env.DOCUMENT_PROCESSOR_DATA_REGION,
    allowedHosts: process.env.DOCUMENT_PROCESSOR_ALLOWED_HOSTS,
    policy,
    production: process.env.NODE_ENV === "production",
  });
  if (
    !document.object_version_id ||
    !document.object_etag ||
    document.object_checksum_sha256 !== document.checksum_sha256
  ) {
    throw Object.assign(
      new Error("Document processor requires an immutable object binding"),
      { permanent: true },
    );
  }
  const { bucket, key } = parseS3Uri(document.object_key);
  const downloadExpiresInSeconds = 300;
  const versionedDownloadUrl = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: document.object_version_id,
      ChecksumMode: "ENABLED",
    }),
    { expiresIn: downloadExpiresInSeconds },
  );
  const response = await fetchWithoutRedirect(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.DOCUMENT_PROCESSOR_TOKEN
        ? { Authorization: `Bearer ${process.env.DOCUMENT_PROCESSOR_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      sourceObject: {
        uri: document.object_key,
        versionId: document.object_version_id,
        etag: document.object_etag,
        checksumSha256: document.checksum_sha256,
        downloadUrl: versionedDownloadUrl,
        downloadUrlExpiresInSeconds: downloadExpiresInSeconds,
      },
      mimeType: document.mime_type,
      sourceType: document.source_type,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Document processor failed with ${response.status}`);
  const parsed = verifyProcessorResponse({
    response: await readBoundedProcessorResponse(response),
    bytes,
    expectedVersionId: document.object_version_id,
    expectedEtag: document.object_etag,
    expectedChecksumSha256: document.checksum_sha256,
  });
  return parsed.chunks.map((chunk) => {
    if (document.source_type !== "BUSINESS_RECORD" && !chunk.effectiveFrom) {
      throw Object.assign(
        new Error("Dated authority and policy chunks require effectiveFrom"),
        { permanent: true },
      );
    }
    if (
      chunk.effectiveFrom &&
      chunk.effectiveTo &&
      new Date(chunk.effectiveTo) <= new Date(chunk.effectiveFrom)
    ) {
      throw Object.assign(new Error("Chunk effective range is invalid"), {
        permanent: true,
      });
    }
    return { ...chunk, sourceType: document.source_type };
  });
}

async function getTenantAiPolicy(tenantId: string) {
  return database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const rows = await transaction<
      Array<{
        ai_enabled: boolean;
        pii_policy: Record<string, unknown>;
        data_region: string;
      }>
    >`
      SELECT ai_enabled, pii_policy, data_region FROM tenants WHERE id = ${tenantId}
    `;
    const row = rows[0];
    if (!row) throw new Error("Tenant AI policy is unavailable");
    return resolveTenantAiPolicy(row.ai_enabled, row.pii_policy, {
      tenantDataRegion: row.data_region,
    });
  });
}

async function embedChunks(chunks: ParsedChunk[], policy: TenantAiPolicy) {
  if (!process.env.AI_GATEWAY_API_KEY || !policy.enabled) {
    return chunks.map(() => undefined);
  }
  let protectedValues: string[];
  try {
    protectedValues = await protectAiOutboundBatch(
      chunks.map((chunk) => chunk.text),
      policy,
    );
  } catch (error) {
    if (error instanceof AiPolicyError && error.code === "AI_PII_BLOCKED") {
      return chunks.map(() => undefined);
    }
    throw error;
  }
  const result = await embedMany({
    model: process.env.AI_EMBEDDING_MODEL_ID ?? "openai/text-embedding-3-small",
    values: protectedValues,
    maxParallelCalls: 2,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(30_000),
    telemetry: {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      functionId: "taxops.ingestion.embed-chunks",
    },
  });
  return result.embeddings;
}

async function recordInjectionScan(
  job: ClaimedJob,
  document: SourceDocument,
  classification: InjectionClassification,
) {
  const maximumRisk = classification.items.reduce(
    (maximum, item) => Math.max(maximum, item.riskScore),
    0,
  );
  const status = classification.items.some(
    (item) => item.label === "SUSPICIOUS",
  )
    ? "BLOCKED"
    : "SAFE";
  const rows = await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    return transaction<{ id: string }[]>`
      UPDATE documents
      SET injection_scan_status = ${status},
          injection_scan_model = ${classification.modelVersion},
          injection_scan_threshold = ${classification.threshold},
          injection_risk_score = ${maximumRisk},
          injection_scanned_at = now(), updated_at = now()
      WHERE id = ${document.id} AND tenant_id = ${job.tenant_id}
        AND version = ${document.version}
        AND object_key = ${document.object_key}
        AND object_version_id = ${document.object_version_id}
        AND object_etag = ${document.object_etag}
        AND object_checksum_sha256 = ${document.object_checksum_sha256}
        AND status = 'SCANNING'
        AND evidence_status = 'PENDING'
      RETURNING id::text
    `;
  });
  if (!rows[0]) throw new LeaseLostError();
  return status;
}

async function persistChunks(
  job: ClaimedJob,
  document: SourceDocument,
  chunks: ParsedChunk[],
  embeddings: Array<number[] | undefined>,
) {
  await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    const lockedDocuments = await transaction<
      Array<{
        version: number;
        status: string;
        evidence_status: string;
        injection_scan_status: string;
      }>
    >`
      SELECT version, status, evidence_status, injection_scan_status
      FROM documents
      WHERE tenant_id = ${job.tenant_id} AND id = ${document.id}
      FOR UPDATE
    `;
    const lockedDocument = lockedDocuments[0];
    if (
      !lockedDocument ||
      lockedDocument.version !== document.version ||
      lockedDocument.status !== "PARSING" ||
      lockedDocument.evidence_status !== "PENDING" ||
      lockedDocument.injection_scan_status !== "SAFE"
    ) {
      throw Object.assign(
        new Error("Document version or ingestion state changed before persist"),
        { permanent: true },
      );
    }
    await transaction`
      UPDATE document_chunks SET is_current = false
      WHERE tenant_id = ${job.tenant_id} AND document_id = ${document.id}
        AND document_version = ${document.version}
    `;
    let characterOffset = 0;
    for (const [index, chunk] of chunks.entries()) {
      const start = chunk.charStart ?? characterOffset;
      const end = chunk.charEnd ?? start + chunk.text.length;
      characterOffset = Math.max(characterOffset, end);
      const hash = createHash("sha256").update(chunk.text).digest("hex");
      const vector = embeddings[index]
        ? `[${embeddings[index]!.join(",")}]`
        : null;
      const rows = await transaction<{ id: string }[]>`
        INSERT INTO document_chunks (
          tenant_id, matter_id, document_id, document_version, chunk_index,
          page_number, section, char_start, char_end, content, content_hash,
          source_type, jurisdiction, effective_from, effective_to,
          is_current, embedding
        )
        SELECT ${job.tenant_id}, source.matter_id, ${document.id}, ${document.version},
               ${index}, ${chunk.page ?? null}, ${chunk.section ?? null}, ${start}, ${end},
               ${chunk.text}, ${hash}, ${chunk.sourceType ?? document.source_type},
               ${chunk.jurisdiction ?? "KR"}, ${chunk.effectiveFrom ?? null},
               ${chunk.effectiveTo ?? null}, true, ${vector}::vector
        FROM documents source
        WHERE source.id = ${document.id} AND source.tenant_id = ${job.tenant_id}
        ON CONFLICT (tenant_id, document_id, document_version, chunk_index)
        DO UPDATE SET is_current = true, embedding = EXCLUDED.embedding
        WHERE document_chunks.content_hash = EXCLUDED.content_hash
          AND document_chunks.char_start = EXCLUDED.char_start
          AND document_chunks.char_end = EXCLUDED.char_end
          AND document_chunks.source_type = EXCLUDED.source_type
          AND document_chunks.jurisdiction = EXCLUDED.jurisdiction
          AND document_chunks.effective_from IS NOT DISTINCT FROM EXCLUDED.effective_from
          AND document_chunks.effective_to IS NOT DISTINCT FROM EXCLUDED.effective_to
        RETURNING id::text
      `;
      if (!rows[0]) {
        throw Object.assign(
          new Error("Existing chunk version does not match parsed content"),
          { permanent: true },
        );
      }
    }
  });
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

async function processDocument(job: ClaimedJob) {
  const documentId = String(job.payload.documentId ?? "");
  if (!documentId)
    throw Object.assign(new Error("documentId is required"), {
      permanent: true,
    });
  const document = await getSourceDocument(job, documentId);
  if (!document)
    throw Object.assign(new Error("Document does not exist in tenant"), {
      permanent: true,
    });

  await database.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
    const transitioned = await transaction<{ id: string }[]>`
      UPDATE documents
      SET status = 'SCANNING', updated_at = now()
      WHERE id = ${documentId} AND tenant_id = ${job.tenant_id}
        AND version = ${document.version}
        AND object_key = ${document.object_key}
        AND object_version_id = ${document.object_version_id}
        AND object_etag = ${document.object_etag}
        AND object_checksum_sha256 = ${document.object_checksum_sha256}
        AND status IN ('QUARANTINED', 'SCANNING', 'PARSING')
        AND evidence_status = 'PENDING'
      RETURNING id::text
    `;
    if (!transitioned[0]) throw new LeaseLostError();
  });
  const sourceObject = await downloadObject(document);
  const bytes = sourceObject.bytes;
  await updateProgress(job, 10);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== document.checksum_sha256) {
    throw Object.assign(
      new Error("Object checksum does not match document record"),
      { permanent: true },
    );
  }
  try {
    await scanWithClamAv(bytes);
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      try {
        await tagObject(document.object_key, sourceObject.versionId, "malware");
      } catch (tagError) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "object.malware_tag_failed",
            documentId,
            errorCode: tagError instanceof Error ? tagError.name : "UNKNOWN",
          }),
        );
      }
    }
    throw error;
  }
  await updateProgress(job, 25);

  const aiPolicy = await getTenantAiPolicy(job.tenant_id);
  const cleanObject = await promoteCleanObject(
    job.tenant_id,
    document,
    sourceObject,
  );
  const cleanDocument = {
    ...document,
    object_key: cleanObject.uri,
    object_version_id: cleanObject.versionId,
    object_etag: cleanObject.etag,
    object_checksum_sha256: cleanObject.checksumSha256,
  };

  try {
    const chunks = await parseDocument(cleanDocument, bytes, aiPolicy);
    // A maximum-sized document requires up to 32 classifier batches. Extend
    // the owned lease before the bounded four-way classification stage.
    await updateProgress(job, 30, 300);
    const sourceControlledFields = [
      cleanDocument.original_name,
      cleanDocument.source_publisher ?? "",
      cleanDocument.source_uri ?? "",
      ...chunks.flatMap((chunk) => [chunk.text, chunk.section ?? ""]),
    ];
    const classification = await classifyProtectedUntrustedSourceBatch(
      sourceControlledFields,
      aiPolicy,
    );
    const scanStatus = await recordInjectionScan(
      job,
      cleanDocument,
      classification,
    );
    if (
      scanStatus === "BLOCKED" ||
      sourceControlledFields.some(detectUntrustedSourceInstruction)
    ) {
      throw Object.assign(
        new Error("Document contains source-controlled workflow instructions"),
        { name: "PROMPT_INJECTION_DETECTED", permanent: true },
      );
    }
    await updateProgress(job, 35);
    const embeddings = await embedChunks(chunks, aiPolicy);
    await updateProgress(job, 55);
    await database.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
      const transitioned = await transaction<{ id: string }[]>`
      UPDATE documents
      SET status = 'PARSING', updated_at = now()
      WHERE id = ${documentId} AND tenant_id = ${job.tenant_id}
        AND version = ${document.version}
        AND object_key = ${cleanObject.uri}
        AND object_version_id = ${cleanObject.versionId}
        AND object_etag = ${cleanObject.etag}
        AND object_checksum_sha256 = ${cleanObject.checksumSha256}
        AND status = 'SCANNING'
        AND evidence_status = 'PENDING'
        AND injection_scan_status = 'SAFE'
      RETURNING id::text
    `;
      if (!transitioned[0]) throw new LeaseLostError();
    });
    // Chunk persistence can issue hundreds of bounded inserts. Give this owned
    // stage a longer lease; completion still rechecks ownership before indexing.
    await updateProgress(job, 65, 600);
    await persistChunks(job, cleanDocument, chunks, embeddings);
    await updateProgress(job, 85);

    await database.begin(async (transaction) => {
      await transaction`SELECT set_config('app.tenant_id', ${job.tenant_id}, true)`;
      const leases = await transaction<{ id: string }[]>`
      SELECT id::text FROM jobs
      WHERE id = ${job.id} AND tenant_id = ${job.tenant_id}
        AND lease_owner = ${workerId} AND status = 'RUNNING'
      FOR UPDATE
    `;
      if (!leases[0]) throw new LeaseLostError();
      const manifestChunks = await transaction<
        Array<{
          id: string;
          chunk_index: number;
          content_hash: string;
          source_type: string;
          jurisdiction: string;
          effective_from: Date | null;
          effective_to: Date | null;
        }>
      >`
      SELECT id::text, chunk_index, content_hash, source_type, jurisdiction,
             effective_from, effective_to
      FROM document_chunks
      WHERE tenant_id = ${job.tenant_id}
        AND document_id = ${documentId}
        AND document_version = ${document.version}
        AND is_current = true
      ORDER BY chunk_index
      FOR SHARE
    `;
      if (manifestChunks.length !== chunks.length) {
        throw Object.assign(
          new Error("Persisted evidence manifest is incomplete"),
          { permanent: true },
        );
      }
      const evidenceManifestSha256 = evidenceManifestHash({
        documentId,
        version: document.version,
        sourceChecksumSha256: document.checksum_sha256,
        sourcePublisher: document.source_publisher,
        sourceUri: document.source_uri,
        acquiredAt: document.acquired_at?.toISOString() ?? null,
        chunks: manifestChunks.map((chunk) => ({
          id: chunk.id,
          chunkIndex: chunk.chunk_index,
          contentHash: chunk.content_hash,
          sourceType: chunk.source_type,
          jurisdiction: chunk.jurisdiction,
          effectiveFrom: chunk.effective_from?.toISOString() ?? null,
          effectiveTo: chunk.effective_to?.toISOString() ?? null,
        })),
      });
      const indexed = await transaction<{ id: string }[]>`
      UPDATE documents
      SET status = 'INDEXED', indexed_at = now(), updated_at = now(),
          evidence_manifest_sha256 = ${evidenceManifestSha256}
      WHERE id = ${documentId} AND tenant_id = ${job.tenant_id}
        AND version = ${document.version}
        AND object_key = ${cleanObject.uri}
        AND object_version_id = ${cleanObject.versionId}
        AND object_etag = ${cleanObject.etag}
        AND object_checksum_sha256 = ${cleanObject.checksumSha256}
        AND status = 'PARSING'
        AND evidence_status = 'PENDING'
        AND injection_scan_status = 'SAFE'
      RETURNING id::text
    `;
      if (!indexed[0]) throw new LeaseLostError();
      await transaction`
      INSERT INTO outbox_events (
        tenant_id, topic, aggregate_type, aggregate_id, payload, idempotency_key
      ) VALUES (
        ${job.tenant_id},
        'document.indexed',
        'document',
        ${documentId},
        ${transaction.json({ documentId })},
        ${`document-indexed:${documentId}`}
      ) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `;
    });
  } catch (error) {
    const processingError =
      error instanceof Error ? error : new Error("Document processing failed");
    throw Object.assign(processingError, { cleanObject });
  }
}

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

void run().catch(async (error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "worker.startup_failed",
      error:
        error instanceof Error ? error.message : "Unknown worker startup error",
    }),
  );
  await database.end({ timeout: 5 }).catch(() => undefined);
  process.exitCode = 1;
});
