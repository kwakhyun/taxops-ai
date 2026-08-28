import { createHash } from "node:crypto";
import {
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import postgres from "postgres";

const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const bucket = process.env.OBJECT_BUCKET;
if (!ownerUrl || !bucket) {
  throw new Error("TEST_DATABASE_OWNER_URL and OBJECT_BUCKET are required");
}

const tenantId = "00000000-0000-4000-8000-000000000001";
const matterId = "00000000-0000-4000-8000-000000000301";
const actorId = "00000000-0000-4000-8000-000000000101";
const safeDocumentId = "00000000-0000-4000-8000-000000000651";
const malwareDocumentId = "00000000-0000-4000-8000-000000000652";
const safeJobId = "00000000-0000-4000-8000-000000000851";
const malwareJobId = "00000000-0000-4000-8000-000000000852";
const safeKey = `${tenantId}/${matterId}/quarantine/worker-smoke-safe`;
const malwareKey = `${tenantId}/${matterId}/quarantine/worker-smoke-eicar`;
const safeBytes = new TextEncoder().encode(
  "부가가치세 worker smoke contract evidence text",
);
const malwareBytes = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
);

const database = postgres(ownerUrl, { max: 1, prepare: false });
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "ap-northeast-2",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
});

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function putFixture(key: string, bytes: Uint8Array) {
  const checksum = sha256(bytes);
  const result = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: "text/plain",
      ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
      Metadata: { lifecycle: "quarantine", sha256: checksum },
      Tagging: "lifecycle=quarantine",
    }),
  );
  if (!result.VersionId || !result.ETag) {
    throw new Error("MinIO immutable object binding contract failed");
  }
  return { checksum, versionId: result.VersionId, etag: result.ETag };
}

async function waitForTerminalJobs() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = await database<
      Array<{
        id: string;
        status: string;
        document_status: string;
        object_key: string;
        object_version_id: string | null;
        object_etag: string | null;
        object_checksum_sha256: string | null;
        evidence_manifest_sha256: string | null;
        chunk_count: number;
      }>
    >`
      SELECT job.id::text, job.status, document.status AS document_status,
             document.object_key, document.object_version_id,
             document.object_etag, document.object_checksum_sha256,
             document.evidence_manifest_sha256,
             count(chunk.id)::int AS chunk_count
      FROM jobs job
      JOIN documents document
        ON document.tenant_id = job.tenant_id
       AND document.id::text = job.payload->>'documentId'
      LEFT JOIN document_chunks chunk
        ON chunk.tenant_id = document.tenant_id
       AND chunk.document_id = document.id
       AND chunk.document_version = document.version
       AND chunk.is_current = true
      WHERE job.id IN (${safeJobId}, ${malwareJobId})
      GROUP BY job.id, document.id
      ORDER BY job.id
    `;
    if (
      rows.length === 2 &&
      rows.every((row) => ["SUCCEEDED", "DEAD"].includes(row.status))
    ) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Worker smoke jobs did not reach terminal states");
}

try {
  await database`
    DELETE FROM jobs WHERE id IN (${safeJobId}, ${malwareJobId})
  `;
  await database`
    DELETE FROM documents WHERE id IN (${safeDocumentId}, ${malwareDocumentId})
  `;
  const safe = await putFixture(safeKey, safeBytes);
  const malware = await putFixture(malwareKey, malwareBytes);

  await database.begin(async (transaction) => {
    await transaction`
      INSERT INTO documents (
        id, tenant_id, matter_id, object_key, object_version_id, object_etag,
        object_checksum_sha256, original_name, normalized_name,
        mime_type, byte_size, checksum_sha256, pii_classification,
        uploaded_by
      ) VALUES
      (
        ${safeDocumentId}, ${tenantId}, ${matterId}, ${`s3://${bucket}/${safeKey}`},
        ${safe.versionId}, ${safe.etag}, ${safe.checksum},
        'worker-smoke-safe.txt', 'worker-smoke-safe.txt', 'text/plain',
        ${safeBytes.length}, ${safe.checksum}, 'INTERNAL', ${actorId}
      ),
      (
        ${malwareDocumentId}, ${tenantId}, ${matterId},
        ${`s3://${bucket}/${malwareKey}`}, ${malware.versionId},
        ${malware.etag}, ${malware.checksum}, 'worker-smoke-eicar.txt',
        'worker-smoke-eicar.txt', 'text/plain', ${malwareBytes.length},
        ${malware.checksum}, 'INTERNAL', ${actorId}
      )
    `;
    await transaction`
      INSERT INTO jobs (
        id, tenant_id, type, idempotency_key, payload, max_attempts
      ) VALUES
      (
        ${safeJobId}, ${tenantId}, 'DOCUMENT_INGESTION',
        'worker-smoke-safe-contract',
        ${transaction.json({ documentId: safeDocumentId })}, 1
      ),
      (
        ${malwareJobId}, ${tenantId}, 'DOCUMENT_INGESTION',
        'worker-smoke-malware-contract',
        ${transaction.json({ documentId: malwareDocumentId })}, 1
      )
    `;
  });

  const rows = await waitForTerminalJobs();
  const safeRow = rows.find((row) => row.id === safeJobId);
  const malwareRow = rows.find((row) => row.id === malwareJobId);
  if (
    safeRow?.status !== "SUCCEEDED" ||
    safeRow.document_status !== "INDEXED" ||
    !safeRow.object_key.includes("/clean/") ||
    !safeRow.object_version_id ||
    !safeRow.object_etag ||
    safeRow.object_checksum_sha256 !== safe.checksum ||
    !safeRow.evidence_manifest_sha256?.match(/^[a-f0-9]{64}$/) ||
    safeRow.chunk_count < 1
  ) {
    throw new Error(
      `Safe ingestion contract failed: ${JSON.stringify(safeRow)}`,
    );
  }
  if (
    malwareRow?.status !== "DEAD" ||
    malwareRow.document_status !== "FAILED"
  ) {
    throw new Error(
      `Malware ingestion contract failed: ${JSON.stringify(malwareRow)}`,
    );
  }

  const clean = new URL(safeRow.object_key.replace("s3://", "https://"));
  const cleanHead = await s3.send(
    new HeadObjectCommand({
      Bucket: clean.hostname,
      Key: clean.pathname.slice(1),
      VersionId: safeRow.object_version_id,
      ChecksumMode: "ENABLED",
    }),
  );
  if (
    cleanHead.VersionId !== safeRow.object_version_id ||
    cleanHead.ETag !== safeRow.object_etag ||
    cleanHead.ChecksumSHA256 !==
      Buffer.from(safe.checksum, "hex").toString("base64")
  ) {
    throw new Error("Clean object checksum contract failed");
  }
  const malwareTags = await s3.send(
    new GetObjectTaggingCommand({
      Bucket: bucket,
      Key: malwareKey,
      VersionId: malware.versionId,
    }),
  );
  if (
    !malwareTags.TagSet?.some(
      (tag) => tag.Key === "lifecycle" && tag.Value === "malware",
    )
  ) {
    throw new Error("Malware lifecycle tag contract failed");
  }
} finally {
  await database.end({ timeout: 2 });
  s3.destroy();
}
