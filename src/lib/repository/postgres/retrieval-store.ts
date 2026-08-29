import "server-only";

import { withTenantSql } from "@/lib/db/client";
import type { Evidence } from "@/lib/domain/types";

interface EvidenceRow {
  id: string;
  matter_id: string;
  document_id: string;
  document_name: string;
  page_number: number | null;
  section: string | null;
  content: string;
  content_hash: string;
  source_type: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  jurisdiction: string;
  effective_from: Date | null;
  effective_to: Date | null;
  source_publisher: string | null;
  source_uri: string | null;
  acquired_at: Date | null;
  score: number;
}

function fullTextQuery(query: string) {
  return query
    .normalize("NFKC")
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((token) => token.length > 1)
    .slice(0, 24)
    .map((token) => `${token}:*`)
    .join(" | ");
}

export async function searchEvidence(input: {
  tenantId: string;
  matterId: string;
  taxReferenceDate: string;
  query: string;
  limit: number;
  embedding?: number[];
}) {
  return withTenantSql(input.tenantId, async (transaction) => {
    const fts = fullTextQuery(input.query) || "__no_match__";
    const vectorValue = input.embedding
      ? `[${input.embedding.join(",")}]`
      : undefined;
    const candidateLimit = Math.min(input.limit * 8, 64);
    const configuredMinimum = Number(process.env.RAG_MIN_SCORE ?? "0.55");
    const minimumScore = Number.isFinite(configuredMinimum)
      ? Math.min(Math.max(configuredMinimum, 0), 1)
      : 0.55;
    const rows = vectorValue
      ? await transaction.unsafe<EvidenceRow[]>(
          `WITH vector_candidates AS (
             SELECT chunk.id
             FROM document_chunks chunk
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
             WHERE chunk.tenant_id = $1 AND chunk.matter_id::text = $2
               AND chunk.is_current = true AND chunk.jurisdiction = 'KR'
               AND document.status = 'INDEXED'
               AND document.evidence_status = 'APPROVED'
               AND document.injection_scan_status = 'SAFE'
               AND chunk.embedding IS NOT NULL
               AND (
                 chunk.source_type = 'BUSINESS_RECORD'
                 OR (
                   chunk.source_type IN ('TAX_AUTHORITY', 'INTERNAL_POLICY')
                   AND chunk.effective_from IS NOT NULL
                   AND chunk.effective_from <= $8::timestamptz
                   AND (chunk.effective_to IS NULL OR chunk.effective_to > $8::timestamptz)
                 )
               )
             ORDER BY chunk.embedding <=> $4::vector
             LIMIT $6
           ), text_candidates AS (
             SELECT chunk.id
             FROM document_chunks chunk
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
             WHERE chunk.tenant_id = $1 AND chunk.matter_id::text = $2
               AND chunk.is_current = true AND chunk.jurisdiction = 'KR'
               AND document.status = 'INDEXED'
               AND document.evidence_status = 'APPROVED'
               AND document.injection_scan_status = 'SAFE'
               AND (
                 chunk.source_type = 'BUSINESS_RECORD'
                 OR (
                   chunk.source_type IN ('TAX_AUTHORITY', 'INTERNAL_POLICY')
                   AND chunk.effective_from IS NOT NULL
                   AND chunk.effective_from <= $8::timestamptz
                   AND (chunk.effective_to IS NULL OR chunk.effective_to > $8::timestamptz)
                 )
               )
               AND to_tsvector('simple', chunk.content) @@ to_tsquery('simple', $3)
             ORDER BY ts_rank_cd(to_tsvector('simple', chunk.content),
                                 to_tsquery('simple', $3)) DESC
             LIMIT $6
           ), candidate_ids AS (
             SELECT id FROM vector_candidates
             UNION
             SELECT id FROM text_candidates
           ), ranked AS (
             SELECT chunk.id::text, chunk.matter_id::text,
                    chunk.document_id::text,
                    document.original_name AS document_name,
                    chunk.page_number, chunk.section, chunk.content,
                    chunk.content_hash, chunk.source_type, chunk.jurisdiction,
                    chunk.effective_from, chunk.effective_to,
                    document.source_publisher, document.source_uri,
                    document.acquired_at,
                    CASE
                      WHEN chunk.embedding IS NULL THEN LEAST(ts_rank_cd(
                        to_tsvector('simple', chunk.content),
                        to_tsquery('simple', $3)
                      ) * 4, 1)::float
                      ELSE (0.65 * (1 - (chunk.embedding <=> $4::vector)) +
                        0.35 * LEAST(ts_rank_cd(
                          to_tsvector('simple', chunk.content),
                          to_tsquery('simple', $3)
                        ) * 4, 1))::float
                    END AS score
             FROM candidate_ids candidate
             JOIN document_chunks chunk ON chunk.id = candidate.id
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
           )
           SELECT * FROM ranked
           WHERE score >= $7
           ORDER BY score DESC
           LIMIT $5`,
          [
            input.tenantId,
            input.matterId,
            fts,
            vectorValue,
            input.limit,
            candidateLimit,
            minimumScore,
            input.taxReferenceDate,
          ],
        )
      : await transaction.unsafe<EvidenceRow[]>(
          `WITH ranked AS (
             SELECT chunk.id::text, chunk.matter_id::text,
                    chunk.document_id::text,
                    document.original_name AS document_name,
                    chunk.page_number, chunk.section, chunk.content,
                    chunk.content_hash, chunk.source_type, chunk.jurisdiction,
                    chunk.effective_from, chunk.effective_to,
                    document.source_publisher, document.source_uri,
                    document.acquired_at,
                    LEAST(ts_rank_cd(to_tsvector('simple', chunk.content),
                                     to_tsquery('simple', $3)) * 4, 1)::float AS score
             FROM document_chunks chunk
             JOIN documents document
               ON document.tenant_id = chunk.tenant_id
              AND document.id = chunk.document_id
              AND document.matter_id = chunk.matter_id
              AND document.version = chunk.document_version
             WHERE chunk.tenant_id = $1 AND chunk.matter_id::text = $2
               AND chunk.is_current = true AND document.status = 'INDEXED'
               AND document.evidence_status = 'APPROVED'
               AND document.injection_scan_status = 'SAFE'
               AND chunk.jurisdiction = 'KR'
               AND (
                 chunk.source_type = 'BUSINESS_RECORD'
                 OR (
                   chunk.source_type IN ('TAX_AUTHORITY', 'INTERNAL_POLICY')
                   AND chunk.effective_from IS NOT NULL
                   AND chunk.effective_from <= $5::timestamptz
                   AND (chunk.effective_to IS NULL OR chunk.effective_to > $5::timestamptz)
                 )
               )
               AND to_tsvector('simple', chunk.content) @@ to_tsquery('simple', $3)
           )
           SELECT * FROM ranked
           WHERE score >= $6
           ORDER BY score DESC
           LIMIT $4`,
          [
            input.tenantId,
            input.matterId,
            fts,
            input.limit,
            input.taxReferenceDate,
            minimumScore,
          ],
        );
    return rows.map(
      (row) =>
        ({
          id: row.id,
          tenantId: input.tenantId,
          matterId: row.matter_id,
          documentId: row.document_id,
          documentName: row.document_name,
          page: row.page_number,
          section: row.section ?? "문서 본문",
          excerpt: row.content,
          contentHash: row.content_hash,
          sourceType: row.source_type,
          jurisdiction: row.jurisdiction,
          effectiveFrom: row.effective_from?.toISOString() ?? null,
          effectiveTo: row.effective_to?.toISOString() ?? null,
          sourcePublisher: row.source_publisher,
          sourceUri: row.source_uri,
          acquiredAt: row.acquired_at?.toISOString() ?? null,
          effectiveDate:
            row.effective_from?.toISOString().slice(0, 10) ?? "unknown",
          score: Number(Number(row.score).toFixed(3)),
        }) satisfies Evidence,
    );
  });
}
