import "server-only";

import type postgres from "postgres";
import { withReviewerTenantSql, withTenantSql } from "@/lib/db/client";
import type { SessionUser } from "@/lib/domain/types";
import {
  mapWorkpaperEvidenceBinding,
  type WorkpaperEvidenceRow,
} from "@/lib/repository/postgres/workpaper-evidence";
import {
  decideWorkpaperViaReviewService,
  reviewServiceIsConfigured,
} from "@/lib/review/service-client";
import {
  hashWorkpaperArtifact,
  workpaperEvidenceBindingMatches,
  workpaperEvidenceBindings,
  type ReviewRequest,
} from "@/lib/workpapers/artifact";

interface ReviewRow {
  target_id: string;
  matter_id: string;
  client: string;
  tax_type: string;
  tax_period: string;
  title: string;
  current_version: number;
  target_version: number;
  stored_artifact_hash: string | null;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  requested_by: string;
  reviewer: string;
  status: ReviewRequest["status"];
  expires_at: Date;
  request_hash: string;
  decision_note: string | null;
}

function mapReviewRequest(row: ReviewRow): ReviewRequest {
  const artifact = {
    targetId: row.target_id,
    matterId: row.matter_id,
    title: row.title,
    version: row.current_version,
    content: row.content,
    provenance: row.provenance,
  };
  const artifactHash = hashWorkpaperArtifact(artifact);
  return {
    ...artifact,
    client: row.client,
    taxType: row.tax_type,
    period: row.tax_period,
    requestedBy: row.requested_by,
    reviewer: row.reviewer,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    requestHash: row.request_hash,
    artifactHash,
    stale:
      artifactHash !== row.request_hash ||
      row.stored_artifact_hash !== row.request_hash ||
      row.current_version !== row.target_version,
    decisionNote: row.decision_note ?? undefined,
  };
}

const reviewSelect = `
  SELECT approval.target_id::text, workpaper.matter_id::text,
         client.name AS client, matter.tax_type, matter.tax_period,
         workpaper.title, workpaper.current_version, version.content,
         approval.target_version, version.artifact_hash AS stored_artifact_hash,
         version.provenance, requester.name AS requested_by,
         reviewer.name AS reviewer, approval.status, approval.expires_at,
         approval.request_hash, approval.decision_note
  FROM approvals approval
  JOIN workpapers workpaper
    ON workpaper.tenant_id = approval.tenant_id
   AND workpaper.id = approval.target_id
  JOIN workpaper_versions version
    ON version.tenant_id = workpaper.tenant_id
   AND version.workpaper_id = workpaper.id
   AND version.version = workpaper.current_version
  JOIN matters matter
    ON matter.tenant_id = workpaper.tenant_id
   AND matter.id = workpaper.matter_id
  JOIN clients client
    ON client.tenant_id = matter.tenant_id AND client.id = matter.client_id
  JOIN users requester ON requester.id = approval.requested_by
  JOIN users reviewer ON reviewer.id = approval.reviewer_id
  WHERE approval.tenant_id = $1
    AND approval.reviewer_id = $2
    AND approval.target_type = 'workpaper'
`;

export async function listReviewRequests(user: SessionUser) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<ReviewRow[]>(
      reviewSelect + " ORDER BY approval.created_at DESC LIMIT 100",
      [user.tenantId, user.id],
    );
    return rows.map(mapReviewRequest);
  });
}

export async function getReviewRequest(user: SessionUser, targetId: string) {
  return withTenantSql(user.tenantId, async (transaction) => {
    const rows = await transaction.unsafe<ReviewRow[]>(
      reviewSelect + " AND approval.target_id::text = $3 LIMIT 1",
      [user.tenantId, user.id, targetId],
    );
    return rows[0] ? mapReviewRequest(rows[0]) : undefined;
  });
}

export async function getReviewDecision(user: SessionUser, targetId: string) {
  const review = await getReviewRequest(user, targetId);
  return review && review.status !== "PENDING" && !review.stale
    ? {
        decision: review.status,
        reviewer: review.reviewer,
        note: review.decisionNote ?? "",
      }
    : undefined;
}

export async function getReviewArtifactHash(
  user: SessionUser,
  targetId: string,
) {
  const review = await getReviewRequest(user, targetId);
  return review &&
    review.status === "PENDING" &&
    !review.stale &&
    new Date(review.expiresAt).getTime() > Date.now()
    ? review.artifactHash
    : undefined;
}

async function artifactEvidenceIsCurrent(
  transaction: postgres.TransactionSql,
  tenantId: string,
  matterId: string,
  content: Record<string, unknown>,
) {
  const bindings = workpaperEvidenceBindings(content);
  if (!bindings) return false;
  const ids = bindings.map((binding) => binding.id);
  const expectedBindings = new Map(
    bindings.map((binding) => [binding.id, binding]),
  );
  const rows = await transaction<WorkpaperEvidenceRow[]>`
    SELECT chunk.id::text, document.original_name AS document_name,
           chunk.page_number, chunk.section, chunk.content AS excerpt,
           chunk.content_hash, chunk.source_type, chunk.jurisdiction,
           chunk.effective_from, chunk.effective_to,
           document.source_publisher, document.source_uri,
           document.acquired_at
    FROM document_chunks chunk
    JOIN documents document
      ON document.tenant_id = chunk.tenant_id
     AND document.id = chunk.document_id
     AND document.matter_id = chunk.matter_id
     AND document.version = chunk.document_version
    WHERE chunk.tenant_id = ${tenantId}
      AND chunk.matter_id = ${matterId}
      AND chunk.id = ANY(${ids}::uuid[])
      AND chunk.is_current = true
      AND document.status = 'INDEXED'
      AND document.evidence_status = 'APPROVED'
      AND document.injection_scan_status = 'SAFE'
      AND document.object_version_id IS NOT NULL
      AND document.object_etag IS NOT NULL
      AND document.object_checksum_sha256 = document.checksum_sha256
  `;
  return (
    rows.length === bindings.length &&
    rows.every((row) => {
      const expected = expectedBindings.get(row.id);
      return (
        expected !== undefined &&
        workpaperEvidenceBindingMatches(
          expected,
          mapWorkpaperEvidenceBinding(row),
        )
      );
    })
  );
}

export async function setReviewDecision(
  user: SessionUser,
  targetId: string,
  input: {
    decision: "APPROVED" | "REJECTED";
    note: string;
    artifactHash: string;
    traceId: string;
    approvalToken?: string;
  },
) {
  if (reviewServiceIsConfigured()) {
    if (!input.approvalToken) return undefined;
    return decideWorkpaperViaReviewService(user, targetId, {
      ...input,
      approvalToken: input.approvalToken,
    });
  }
  return withReviewerTenantSql(user.tenantId, async (transaction) => {
    const artifactRows = await transaction<
      Array<{
        version: number;
        content: Record<string, unknown>;
        provenance: Record<string, unknown>;
        request_hash: string;
        artifact_hash: string | null;
        target_version: number;
        current_version: number;
        matter_id: string;
        title: string;
      }>
    >`
      SELECT version.version, version.content, version.provenance,
             approval.request_hash, version.artifact_hash,
             approval.target_version, workpaper.current_version,
             workpaper.matter_id::text, workpaper.title
      FROM approvals approval
      JOIN workpapers workpaper
        ON workpaper.tenant_id = approval.tenant_id
       AND workpaper.id = approval.target_id
      JOIN workpaper_versions version
        ON version.tenant_id = workpaper.tenant_id
       AND version.workpaper_id = workpaper.id
       AND version.version = workpaper.current_version
      WHERE approval.tenant_id = ${user.tenantId}
        AND approval.target_id::text = ${targetId}
        AND approval.target_type = 'workpaper'
        AND approval.reviewer_id = ${user.id}
        AND approval.status = 'PENDING'
        AND approval.expires_at > now()
    `;
    const artifact = artifactRows[0];
    if (!artifact) return undefined;
    const currentHash = hashWorkpaperArtifact({
      targetId,
      matterId: artifact.matter_id,
      title: artifact.title,
      version: artifact.version,
      content: artifact.content,
      provenance: artifact.provenance,
    });
    if (
      currentHash !== artifact.request_hash ||
      currentHash !== artifact.artifact_hash ||
      artifact.current_version !== artifact.target_version ||
      currentHash !== input.artifactHash
    ) {
      return undefined;
    }
    if (
      !(await artifactEvidenceIsCurrent(
        transaction,
        user.tenantId,
        artifact.matter_id,
        artifact.content,
      ))
    ) {
      return undefined;
    }
    const rows = await transaction<
      Array<{ decision: "APPROVED" | "REJECTED" }>
    >`
      SELECT decision
      FROM decide_workpaper_review(
        ${user.tenantId}::uuid, ${targetId}::uuid, ${user.id}::uuid,
        ${input.decision}, ${input.note}, ${input.artifactHash}, ${input.traceId}
      )
    `;
    const decided = rows[0];
    if (!decided) return undefined;
    return {
      decision: decided.decision,
      reviewer: user.name,
      note: input.note,
    };
  });
}
