import postgres from "postgres";
import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { embedMany } from "ai";
import { evidenceManifestHash } from "../lib/documents/evidence-manifest.ts";
import type { ParsedChunk } from "../lib/files/chunking.ts";
import { detectUntrustedSourceInstruction } from "../lib/ai/guardrails.ts";
import {
  classifyProtectedUntrustedSourceBatch,
  type InjectionClassification,
} from "../lib/security/injection-classifier.ts";
import {
  AiPolicyError,
  protectAiOutboundBatch,
  resolveTenantAiPolicy,
  type TenantAiPolicy,
} from "../lib/security/ai-policy.ts";
import { parseDocument, scanWithClamAv } from "./document-processor-client.ts";
import {
  LeaseLostError,
  MalwareDetectedError,
  type ClaimedJob,
  type SourceDocument,
} from "./contracts.ts";
import {
  cleanObjectKey,
  encodedCopySource,
  getS3Client,
  parseS3Uri,
} from "./object-storage-client.ts";

export function createDocumentIngestionService(input: {
  database: ReturnType<typeof postgres>;
  workerId: string;
  updateProgress: (
    job: ClaimedJob,
    progress: number,
    leaseSeconds?: number,
  ) => Promise<void>;
}) {
  const { database, workerId, updateProgress } = input;
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
      model:
        process.env.AI_EMBEDDING_MODEL_ID ?? "openai/text-embedding-3-small",
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
          new Error(
            "Document version or ingestion state changed before persist",
          ),
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
          await tagObject(
            document.object_key,
            sourceObject.versionId,
            "malware",
          );
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
          new Error(
            "Document contains source-controlled workflow instructions",
          ),
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
        error instanceof Error
          ? error
          : new Error("Document processing failed");
      throw Object.assign(processingError, { cleanObject });
    }
  }

  return { processDocument, tagObject };
}
