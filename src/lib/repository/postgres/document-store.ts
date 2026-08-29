import "server-only";

import { withReviewerTenantSql, withTenantSql } from "@/lib/db/client";
import { evidenceManifestHash } from "@/lib/documents/evidence-manifest";
import type {
  DocumentRecord,
  EvidenceReviewPreview,
  SessionUser,
} from "@/lib/domain/types";
import type { DocumentDownloadDescriptor } from "@/lib/files/download";
import { detectPromptInjection } from "@/lib/ai/guardrails";
import type { DemoJob } from "@/lib/repository/demo-store";
import { appendAuditEventTx } from "@/lib/repository/postgres/audit-store";
import { displayDate } from "@/lib/repository/postgres/date-format";
import { RepositoryInputError } from "@/lib/repository/postgres/errors";
import {
  decideEvidenceViaReviewService,
  reviewServiceIsConfigured,
} from "@/lib/review/service-client";
import { normalizeTrustedSourceUri } from "@/lib/security/source-provenance";
interface DocumentRow {
  id: string;
  matter_id: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  status: DocumentRecord["status"];
  evidence_status: DocumentRecord["evidenceStatus"];
  pii_classification: DocumentRecord["piiClass"];
  uploader_name: string;
  updated_at: Date;
  checksum_sha256: string;
  source_type: DocumentRecord["sourceType"];
  source_publisher?: string | null;
  source_uri?: string | null;
  acquired_at?: Date | null;
  evidence_manifest_sha256?: string | null;
  uploaded_by?: string;
  evidence_reviewable?: boolean;
  version?: number;
  chunk_count?: number;
  page_count?: number;
}

interface JobRow {
  id: string;
  tenant_id: string;
  type: DemoJob["type"];
  status: DemoJob["status"];
  progress: number;
  idempotency_key: string;
  payload: { documentId?: string };
  created_at: Date;
}

interface DocumentDownloadRow {
  original_name: string;
  mime_type: string;
  object_key: string;
  object_version_id: string | null;
  object_checksum_sha256: string | null;
  checksum_sha256: string;
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    matterId: row.matter_id,
    name: row.original_name,
    kind:
      row.mime_type.includes("spreadsheet") || row.mime_type === "text/csv"
        ? "원장"
        : "증빙",
    size: `${(Number(row.byte_size) / 1024 / 1024).toFixed(2)} MB`,
    status: row.status,
    evidenceStatus: row.evidence_status,
    pages: Number(row.page_count ?? 0),
    chunks: Number(row.chunk_count ?? 0),
    piiClass: row.pii_classification,
    uploadedBy: row.uploader_name,
    updatedAt: displayDate(row.updated_at),
    checksum: `sha256:${row.checksum_sha256.slice(0, 8)}…${row.checksum_sha256.slice(-4)}`,
    sourceType: row.source_type,
    evidenceReviewable: row.evidence_reviewable ?? false,
  };
}

function mapJob(row: JobRow): DemoJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    idempotencyKey: row.idempotency_key,
    resourceId: row.payload.documentId ?? "",
    createdAt: row.created_at.toISOString(),
  };
}

export async function listDocuments(user: SessionUser, matterId?: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<DocumentRow[]>(
      `SELECT d.id::text, d.matter_id::text, d.original_name, d.mime_type,
              d.byte_size, d.status, d.evidence_status, d.pii_classification,
              d.source_type,
              uploader.name AS uploader_name,
              d.updated_at, d.checksum_sha256,
              (matter.reviewer_id::text = $3 AND d.uploaded_by::text <> $3)
                AS evidence_reviewable,
              count(chunk.id)::int AS chunk_count,
              coalesce(max(chunk.page_number), 0)::int AS page_count
       FROM documents d
       JOIN matters matter
         ON matter.tenant_id = d.tenant_id AND matter.id = d.matter_id
       JOIN users uploader ON uploader.id = d.uploaded_by
       LEFT JOIN document_chunks chunk
         ON chunk.tenant_id = d.tenant_id
        AND chunk.document_id = d.id
        AND chunk.matter_id = d.matter_id
        AND chunk.document_version = d.version
        AND chunk.is_current = true
       WHERE d.tenant_id = $1 AND ($2::text IS NULL OR d.matter_id::text = $2)
       GROUP BY d.id, uploader.name, matter.reviewer_id
       ORDER BY d.updated_at DESC`,
      [user.tenantId, matterId ?? null, user.id],
    );
    return rows.map(mapDocument);
  });
}

export async function getDocumentDownload(
  user: SessionUser,
  documentId: string,
): Promise<DocumentDownloadDescriptor | undefined> {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<DocumentDownloadRow[]>`
      SELECT original_name, mime_type, object_key, object_version_id,
             object_checksum_sha256, checksum_sha256
      FROM documents
      WHERE tenant_id = ${user.tenantId}
        AND id::text = ${documentId}
        AND status = 'INDEXED'
      LIMIT 1
    `;
    const document = rows[0];
    if (!document) return undefined;
    if (
      process.env.NODE_ENV === "production" &&
      (!document.object_key.startsWith("s3://") ||
        !document.object_version_id ||
        document.object_checksum_sha256 !== document.checksum_sha256)
    ) {
      return undefined;
    }
    return {
      name: document.original_name,
      mimeType: document.mime_type,
      objectKey: document.object_key,
      objectVersionId: document.object_version_id ?? undefined,
      objectChecksumSha256:
        document.object_checksum_sha256 ?? document.checksum_sha256,
    };
  });
}

export async function getDocumentEvidenceReview(
  user: SessionUser,
  documentId: string,
): Promise<EvidenceReviewPreview | undefined> {
  return withTenantSql(user.tenantId, async (transaction) => {
    const documents = await transaction<
      Array<
        DocumentRow & {
          version: number;
          chunk_count: number;
        }
      >
    >`
      SELECT document.id::text, document.matter_id::text,
             document.original_name, document.mime_type, document.byte_size,
             document.status, document.evidence_status,
             document.pii_classification, uploader.name AS uploader_name,
             document.updated_at, document.checksum_sha256, document.source_type,
             document.source_publisher, document.source_uri,
             document.acquired_at, document.evidence_manifest_sha256,
             document.version,
             count(chunk.id)::int AS chunk_count
      FROM documents document
      JOIN matters matter
        ON matter.tenant_id = document.tenant_id
       AND matter.id = document.matter_id
      JOIN users uploader ON uploader.id = document.uploaded_by
      LEFT JOIN document_chunks chunk
        ON chunk.tenant_id = document.tenant_id
       AND chunk.document_id = document.id
       AND chunk.document_version = document.version
       AND chunk.is_current = true
      WHERE document.tenant_id = ${user.tenantId}
        AND document.id::text = ${documentId}
        AND document.status = 'INDEXED'
        AND document.evidence_status = 'PENDING'
        AND document.injection_scan_status = 'SAFE'
        AND matter.reviewer_id::text = ${user.id}
        AND document.uploaded_by::text <> ${user.id}
      GROUP BY document.id, uploader.name
    `;
    const document = documents[0];
    if (!document) return undefined;
    const chunks = await transaction<
      Array<{
        id: string;
        chunk_index: number;
        page_number: number | null;
        section: string | null;
        excerpt: string;
        content_hash: string;
        source_type: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
        jurisdiction: string;
        effective_from: Date | null;
        effective_to: Date | null;
      }>
    >`
      SELECT chunk.id::text, chunk.chunk_index, chunk.page_number,
             chunk.section, chunk.content AS excerpt, chunk.content_hash,
             chunk.source_type, chunk.jurisdiction, chunk.effective_from,
             chunk.effective_to
      FROM document_chunks chunk
      WHERE chunk.tenant_id = ${user.tenantId}
        AND chunk.document_id::text = ${documentId}
        AND chunk.document_version = ${document.version}
        AND chunk.is_current = true
      ORDER BY chunk.chunk_index
    `;
    if (chunks.length === 0) return undefined;
    const manifestSha256 = evidenceManifestHash({
      documentId: document.id,
      version: document.version,
      sourceChecksumSha256: document.checksum_sha256,
      sourcePublisher: document.source_publisher,
      sourceUri: document.source_uri,
      acquiredAt: document.acquired_at?.toISOString() ?? null,
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunk_index,
        contentHash: chunk.content_hash,
        sourceType: chunk.source_type,
        jurisdiction: chunk.jurisdiction,
        effectiveFrom: chunk.effective_from?.toISOString() ?? null,
        effectiveTo: chunk.effective_to?.toISOString() ?? null,
      })),
    });
    if (document.evidence_manifest_sha256 !== manifestSha256) return undefined;
    return {
      documentId: document.id,
      matterId: document.matter_id,
      name: document.original_name,
      version: document.version,
      uploadedBy: document.uploader_name,
      checksumSha256: document.checksum_sha256,
      manifestSha256,
      chunkCount: Number(document.chunk_count),
      sourcePublisher: document.source_publisher ?? null,
      sourceUri: document.source_uri ?? null,
      acquiredAt: document.acquired_at?.toISOString() ?? null,
      previewChunks: chunks.map((chunk) => ({
        id: chunk.id,
        page: chunk.page_number,
        section: chunk.section,
        excerpt: chunk.excerpt,
        contentHash: chunk.content_hash,
        sourceType: chunk.source_type,
        jurisdiction: chunk.jurisdiction,
        effectiveFrom: chunk.effective_from?.toISOString() ?? null,
        effectiveTo: chunk.effective_to?.toISOString() ?? null,
      })),
    };
  });
}

export async function setDocumentEvidenceDecision(
  user: SessionUser,
  documentId: string,
  decision: "APPROVED" | "REJECTED",
  expectedChecksumSha256: string,
  expectedManifestSha256: string,
  traceId?: string,
) {
  if (reviewServiceIsConfigured()) {
    const result = await decideEvidenceViaReviewService(user, documentId, {
      decision,
      checksumSha256: expectedChecksumSha256,
      manifestSha256: expectedManifestSha256,
      traceId: traceId ?? `tr_${crypto.randomUUID()}`,
    });
    if (!result) return undefined;
    return (await listDocuments(user)).find(
      (document) => document.id === result.documentId,
    );
  }
  return withReviewerTenantSql(user.tenantId, async (transaction) => {
    const scopes = await transaction<
      Array<
        DocumentRow & {
          version: number;
        }
      >
    >`
      SELECT document.id::text, document.matter_id::text,
             document.original_name, document.mime_type, document.byte_size,
             document.status, document.evidence_status,
             document.pii_classification, uploader.name AS uploader_name,
             document.updated_at, document.checksum_sha256, document.source_type,
             document.source_publisher, document.source_uri,
             document.acquired_at, document.evidence_manifest_sha256,
             document.version
      FROM documents document
      JOIN matters matter
        ON matter.tenant_id = document.tenant_id
       AND matter.id = document.matter_id
      JOIN users uploader ON uploader.id = document.uploaded_by
      WHERE document.tenant_id = ${user.tenantId}
        AND document.id::text = ${documentId}
        AND document.status = 'INDEXED'
        AND document.evidence_status = 'PENDING'
        AND document.injection_scan_status = 'SAFE'
        AND matter.reviewer_id::text = ${user.id}
        AND document.uploaded_by::text <> ${user.id}
        AND document.checksum_sha256 = ${expectedChecksumSha256}
    `;
    const scope = scopes[0];
    if (!scope) return undefined;
    const manifestRows = await transaction<
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
      WHERE tenant_id = ${user.tenantId}
        AND document_id::text = ${documentId}
        AND document_version = ${scope.version}
        AND is_current = true
      ORDER BY chunk_index
    `;
    if (
      manifestRows.length === 0 ||
      evidenceManifestHash({
        documentId: scope.id,
        version: scope.version,
        sourceChecksumSha256: scope.checksum_sha256,
        sourcePublisher: scope.source_publisher,
        sourceUri: scope.source_uri,
        acquiredAt: scope.acquired_at?.toISOString() ?? null,
        chunks: manifestRows.map((chunk) => ({
          id: chunk.id,
          chunkIndex: chunk.chunk_index,
          contentHash: chunk.content_hash,
          sourceType: chunk.source_type,
          jurisdiction: chunk.jurisdiction,
          effectiveFrom: chunk.effective_from?.toISOString() ?? null,
          effectiveTo: chunk.effective_to?.toISOString() ?? null,
        })),
      }) !== expectedManifestSha256 ||
      scope.evidence_manifest_sha256 !== expectedManifestSha256
    ) {
      return undefined;
    }
    const decisions = await transaction<{ id: string }[]>`
      SELECT document_id::text AS id
      FROM decide_document_evidence(
        ${user.tenantId}::uuid, ${documentId}::uuid, ${user.id}::uuid,
        ${decision}, ${expectedChecksumSha256}, ${scope.version},
        ${expectedManifestSha256}, ${traceId ?? `tr_${crypto.randomUUID()}`}
      )
    `;
    if (!decisions[0]) return undefined;
    const rows = await transaction<DocumentRow[]>`
      SELECT document.id::text, document.matter_id::text,
             document.original_name, document.mime_type, document.byte_size,
             document.status, document.evidence_status,
             document.pii_classification, uploader.name AS uploader_name,
             document.updated_at, document.checksum_sha256,
             document.source_type
      FROM documents document
      JOIN users uploader ON uploader.id = document.uploaded_by
      WHERE document.tenant_id = ${user.tenantId}
        AND document.id::text = ${documentId}
    `;
    const document = rows[0] ? mapDocument(rows[0]) : undefined;
    return document;
  });
}

export async function enqueueDocument(
  user: SessionUser,
  input: {
    matterId: string;
    name: string;
    mimeType: string;
    size: number;
    checksum: string;
    objectKey?: string;
    objectVersionId?: string;
    objectEtag?: string;
    objectChecksumSha256?: string;
    idempotencyKey: string;
    sourceType: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
    sourcePublisher?: string;
    sourceUri?: string;
    acquiredAt?: string;
    traceId?: string;
  },
) {
  let normalizedSourceUri: string | undefined;
  try {
    normalizedSourceUri = input.sourceUri
      ? normalizeTrustedSourceUri(input.sourceUri)
      : undefined;
  } catch {
    throw new RepositoryInputError(
      "출처 주소는 허용된 HTTPS 도메인을 사용해야 합니다.",
      "SOURCE_URI_NOT_ALLOWED",
    );
  }
  if (
    input.sourcePublisher &&
    detectPromptInjection(input.sourcePublisher.normalize("NFKC"))
  ) {
    throw new RepositoryInputError(
      "발행기관에 안전하지 않은 지시 패턴이 포함되어 있습니다.",
      "SOURCE_PROVENANCE_UNSAFE",
    );
  }
  if (
    input.sourceType === "TAX_AUTHORITY" &&
    (!input.sourcePublisher || !normalizedSourceUri || !input.acquiredAt)
  ) {
    throw new RepositoryInputError(
      "공식 세무 자료에는 발행기관, 원문 주소, 수집 시각이 필요합니다.",
      "SOURCE_PROVENANCE_REQUIRED",
    );
  }
  const hasObjectBinding =
    input.objectVersionId !== undefined ||
    input.objectEtag !== undefined ||
    input.objectChecksumSha256 !== undefined;
  if (
    hasObjectBinding &&
    (!input.objectVersionId ||
      !input.objectEtag ||
      input.objectChecksumSha256 !== input.checksum)
  ) {
    throw new RepositoryInputError(
      "업로드 파일의 저장소 버전 정보와 체크섬이 일치하지 않습니다.",
      "OBJECT_BINDING_INVALID",
    );
  }
  if (
    process.env.NODE_ENV === "production" &&
    (!input.objectKey?.startsWith("s3://") || !hasObjectBinding)
  ) {
    throw new RepositoryInputError(
      "운영 환경에서는 파일 변경 방지를 위한 S3 객체 버전 정보가 필요합니다.",
      "OBJECT_BINDING_REQUIRED",
    );
  }
  return withTenantSql(user.tenantId, async (transaction) => {
    async function finalize<
      T extends {
        document: DocumentRecord;
        job: DemoJob;
        deduplicated: boolean;
      },
    >(result: T) {
      if (input.traceId) {
        await appendAuditEventTx(transaction, user, {
          action: result.deduplicated
            ? "DOCUMENT_UPLOAD_DEDUPLICATED"
            : "DOCUMENT_QUEUED",
          targetType: "document",
          targetId: result.document.id,
          outcome: "SUCCESS",
          traceId: input.traceId,
          metadata: { jobId: result.job.id },
        });
      }
      return result;
    }
    const existingByChecksum = async () => {
      const documentRows = await transaction<DocumentRow[]>`
        SELECT d.id::text, d.matter_id::text, d.original_name, d.mime_type,
               d.byte_size, d.status, d.evidence_status, d.pii_classification,
               uploader.name AS uploader_name, d.updated_at, d.checksum_sha256,
               d.source_type, d.source_publisher, d.source_uri, d.acquired_at,
               d.uploaded_by::text
        FROM documents d
        JOIN users uploader ON uploader.id = d.uploaded_by
        WHERE d.tenant_id = ${user.tenantId}
          AND d.matter_id::text = ${input.matterId}
          AND d.checksum_sha256 = ${input.checksum}
        LIMIT 1
      `;
      const document = documentRows[0];
      if (!document) return undefined;
      if (document.uploaded_by !== user.id) {
        throw new RepositoryInputError(
          "다른 작성자가 업로드한 동일 파일은 자동 중복 처리하지 않습니다.",
          "CROSS_ACTOR_DEDUPLICATION_DENIED",
        );
      }
      if (document.source_type !== input.sourceType) {
        throw new RepositoryInputError(
          "동일 파일은 기존 출처 분류와 다르게 재사용할 수 없습니다. 별도 재분류 검토가 필요합니다.",
          "SOURCE_CLASSIFICATION_CONFLICT",
        );
      }
      if (
        document.source_publisher !== (input.sourcePublisher ?? null) ||
        document.source_uri !== (normalizedSourceUri ?? null)
      ) {
        throw new RepositoryInputError(
          "동일 파일의 공식 출처 이력이 기존 기록과 다릅니다.",
          "SOURCE_PROVENANCE_CONFLICT",
        );
      }
      const jobRows = await transaction<JobRow[]>`
        SELECT id::text, tenant_id::text, type, status, progress,
               idempotency_key, payload, created_at
        FROM jobs
        WHERE tenant_id = ${user.tenantId}
          AND payload->>'documentId' = ${document.id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      const job = jobRows[0];
      return job
        ? {
            document: mapDocument(document),
            job: mapJob(job),
            deduplicated: true as const,
          }
        : undefined;
    };

    const existingJobs = await transaction<JobRow[]>`
      SELECT id::text, tenant_id::text, type, status, progress, idempotency_key,
             payload, created_at
      FROM jobs
      WHERE tenant_id = ${user.tenantId} AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    const existingJob = existingJobs[0];
    if (existingJob?.payload.documentId) {
      const documentRows = await transaction<DocumentRow[]>`
        SELECT d.id::text, d.matter_id::text, d.original_name, d.mime_type,
               d.byte_size, d.status, d.evidence_status, d.pii_classification,
               u.name AS uploader_name,
               d.updated_at, d.checksum_sha256, d.source_type,
               d.source_publisher, d.source_uri, d.acquired_at,
               d.uploaded_by::text
        FROM documents d JOIN users u ON u.id = d.uploaded_by
        WHERE d.tenant_id = ${user.tenantId} AND d.id::text = ${existingJob.payload.documentId}
        LIMIT 1
      `;
      if (documentRows[0]) {
        const document = documentRows[0];
        if (
          document.matter_id !== input.matterId ||
          document.checksum_sha256 !== input.checksum ||
          document.original_name !== input.name ||
          document.mime_type !== input.mimeType ||
          Number(document.byte_size) !== input.size ||
          document.source_type !== input.sourceType ||
          document.uploaded_by !== user.id ||
          document.source_publisher !== (input.sourcePublisher ?? null) ||
          document.source_uri !== (normalizedSourceUri ?? null)
        ) {
          throw new RepositoryInputError(
            "같은 중복 요청 방지 키를 다른 업로드에 재사용할 수 없습니다.",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        return finalize({
          document: mapDocument(document),
          job: mapJob(existingJob),
          deduplicated: true,
        });
      }
    }

    const checksumMatch = await existingByChecksum();
    if (checksumMatch) return finalize(checksumMatch);

    const documentRows = await transaction<DocumentRow[]>`
      INSERT INTO documents (
        tenant_id, matter_id, object_key, object_version_id, object_etag,
        object_checksum_sha256, original_name, normalized_name,
        mime_type, byte_size, checksum_sha256, pii_classification, source_type,
        source_publisher, source_uri, acquired_at, uploaded_by
      ) VALUES (
        ${user.tenantId}, ${input.matterId}, ${input.objectKey ?? "quarantine://missing"},
        ${input.objectVersionId ?? null}, ${input.objectEtag ?? null},
        ${input.objectChecksumSha256 ?? null},
        ${input.name}, ${input.name}, ${input.mimeType}, ${input.size}, ${input.checksum},
        'RESTRICTED', ${input.sourceType}, ${input.sourcePublisher ?? null},
        ${normalizedSourceUri ?? null}, ${input.acquiredAt ?? null}, ${user.id}
      )
      ON CONFLICT (tenant_id, matter_id, checksum_sha256) DO NOTHING
      RETURNING id::text, matter_id::text, original_name, mime_type, byte_size,
                status, evidence_status, pii_classification,
                ${user.name}::text AS uploader_name,
                updated_at, checksum_sha256, source_type, source_publisher,
                source_uri, acquired_at
    `;
    const document = documentRows[0];
    if (!document) {
      const racedMatch = await existingByChecksum();
      if (racedMatch) return finalize(racedMatch);
      throw new Error("Document insert did not return an id");
    }
    const jobRows = await transaction<JobRow[]>`
      INSERT INTO jobs (tenant_id, type, idempotency_key, payload)
      VALUES (
        ${user.tenantId}, 'DOCUMENT_INGESTION', ${input.idempotencyKey},
        ${transaction.json({ documentId: document.id })}
      )
      RETURNING id::text, tenant_id::text, type, status, progress,
                idempotency_key, payload, created_at
    `;
    const job = jobRows[0];
    if (!job) throw new Error("Job insert did not return an id");
    return finalize({
      document: mapDocument(document),
      job: mapJob(job),
      deduplicated: false,
    });
  });
}

export async function getJob(user: SessionUser, id: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction<JobRow[]>`
      SELECT id::text, tenant_id::text, type, status, progress, idempotency_key,
             payload, created_at
      FROM jobs
      WHERE tenant_id = ${user.tenantId} AND id::text = ${id}
      LIMIT 1
    `;
    return rows[0] ? mapJob(rows[0]) : undefined;
  });
}
