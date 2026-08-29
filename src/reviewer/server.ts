import { createRemoteJWKSet, jwtVerify } from "jose";
import postgres from "postgres";
import { providerJwtValidationOptions } from "../lib/auth/token-policy.ts";
import {
  isValidApprovalTokenSecret,
  issueApprovalToken,
  verifyApprovalToken,
} from "../lib/security/approval-token.ts";
import { evidenceManifestHash } from "../lib/documents/evidence-manifest.ts";
import {
  hashWorkpaperArtifact,
  workpaperEvidenceBindingMatches,
  workpaperEvidenceBindings,
  type WorkpaperEvidenceBinding,
} from "../lib/workpapers/artifact.ts";
import {
  type ActorInput,
  type EvidenceInput,
  type TokenRequestInput,
  type WorkpaperInput,
} from "./contracts.ts";
import { logReviewEvent } from "./http-transport.ts";
import { createReviewerHttpServer } from "./http-server.ts";

const databaseUrl = process.env.REVIEW_DATABASE_URL;
const sharedSecret = process.env.REVIEW_SERVICE_SHARED_SECRET;
const oidcIssuer = process.env.OIDC_ISSUER;
const oidcJwksUrl = process.env.OIDC_JWKS_URL;
const oidcReviewAudience = process.env.OIDC_REVIEW_AUDIENCE;
const oidcReviewScope = process.env.OIDC_REVIEW_SCOPE;
const oidcReviewRequiredAcr = process.env.OIDC_REVIEW_REQUIRED_ACR;
const oidcWebClientId = process.env.OIDC_CLIENT_ID;
if (
  !databaseUrl ||
  !sharedSecret ||
  !oidcIssuer ||
  !oidcJwksUrl ||
  !oidcReviewAudience ||
  !oidcReviewScope ||
  !oidcReviewRequiredAcr ||
  !oidcWebClientId ||
  !isValidApprovalTokenSecret(process.env.APPROVAL_TOKEN_SECRET)
) {
  throw new Error(
    "Reviewer database, transport secret and OIDC verifier configuration are required",
  );
}

async function issueWorkpaperTokens(input: TokenRequestInput) {
  const identity = await verifiedIdentity(input);
  return sql.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${identity.tenantId}, true)`;
    const actor = await resolveReviewer(
      transaction,
      identity,
      input.expectedActor,
    );
    const rows = await transaction<
      Array<{
        version: number;
        content: Record<string, unknown>;
        provenance: Record<string, unknown>;
        matter_id: string;
        title: string;
        request_hash: string;
      }>
    >`
      SELECT version.version, version.content, version.provenance,
             workpaper.matter_id::text, workpaper.title,
             approval.request_hash
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
      JOIN agent_runs run
        ON run.tenant_id = workpaper.tenant_id
       AND run.id::text = version.provenance->>'runId'
      WHERE approval.tenant_id = ${actor.tenantId}
        AND approval.target_id = ${input.targetId}
        AND approval.target_type = 'workpaper'
        AND approval.reviewer_id = ${actor.id}
        AND approval.requested_by <> ${actor.id}
        AND approval.status = 'PENDING'
        AND approval.expires_at > now()
        AND approval.request_hash = ${input.artifactHash}
        AND approval.target_version = workpaper.current_version
        AND version.artifact_hash = ${input.artifactHash}
        AND matter.reviewer_id = ${actor.id}
        AND run.workflow_status = 'AWAITING_REVIEW'
        AND run.completed_at IS NOT NULL
        AND run.error_code IS NULL
    `;
    const artifact = rows[0];
    if (!artifact) return undefined;
    const currentHash = hashWorkpaperArtifact({
      targetId: input.targetId,
      matterId: artifact.matter_id,
      title: artifact.title,
      version: artifact.version,
      content: artifact.content,
      provenance: artifact.provenance,
    });
    if (
      currentHash !== input.artifactHash ||
      currentHash !== artifact.request_hash
    ) {
      return undefined;
    }
    if (
      !(await artifactEvidenceIsCurrent(
        transaction,
        actor.tenantId,
        artifact.matter_id,
        artifact.content,
      ))
    ) {
      return undefined;
    }
    return {
      ok: true as const,
      tokens: {
        APPROVED: issueApprovalToken({
          actorId: actor.id,
          targetId: input.targetId,
          artifactHash: input.artifactHash,
          decision: "APPROVED",
        }),
        REJECTED: issueApprovalToken({
          actorId: actor.id,
          targetId: input.targetId,
          artifactHash: input.artifactHash,
          decision: "REJECTED",
        }),
      },
      expiresInSeconds: 300,
    };
  });
}
const oidcJwks = createRemoteJWKSet(new URL(oidcJwksUrl));
const sql = postgres(databaseUrl, {
  max: 8,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});
async function verifiedIdentity(input: {
  identityToken: string;
  expectedActor: ActorInput;
}) {
  const { payload } = await jwtVerify(input.identityToken, oidcJwks, {
    ...providerJwtValidationOptions(oidcIssuer!, oidcReviewAudience!),
    requiredClaims: [
      "sub",
      "iat",
      "exp",
      "tenant_id",
      "scope",
      "auth_time",
      "acr",
    ],
    maxTokenAge: "15m",
  });
  const scopes =
    typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  const authorizedClient =
    payload.azp === oidcWebClientId || payload.client_id === oidcWebClientId;
  const authenticationTime =
    typeof payload.auth_time === "number" ? payload.auth_time * 1_000 : NaN;
  if (
    typeof payload.sub !== "string" ||
    typeof payload.tenant_id !== "string" ||
    payload.tenant_id !== input.expectedActor.tenantId ||
    !scopes.includes(oidcReviewScope!) ||
    !authorizedClient ||
    payload.acr !== oidcReviewRequiredAcr ||
    !Number.isFinite(authenticationTime) ||
    authenticationTime > Date.now() + 30_000 ||
    Date.now() - authenticationTime > 15 * 60_000
  ) {
    throw new Error("OIDC_IDENTITY_MISMATCH");
  }
  return { subject: payload.sub, tenantId: payload.tenant_id };
}

async function resolveReviewer(
  transaction: postgres.TransactionSql,
  identity: { subject: string; tenantId: string },
  expectedActor: ActorInput,
) {
  const reviewers = await transaction<Array<{ id: string; name: string }>>`
    SELECT account.id::text, account.name
    FROM users account
    JOIN memberships membership ON membership.user_id = account.id
    WHERE account.oidc_subject = ${identity.subject}
      AND membership.tenant_id = ${identity.tenantId}
      AND membership.role IN ('REVIEWER', 'ADMIN')
    LIMIT 1
  `;
  const reviewer = reviewers[0];
  if (
    !reviewer ||
    reviewer.id !== expectedActor.id ||
    reviewer.name !== expectedActor.name
  ) {
    throw new Error("REVIEWER_MEMBERSHIP_MISMATCH");
  }
  return { ...reviewer, tenantId: identity.tenantId };
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
  const rows = await transaction<
    Array<{
      id: string;
      document_name: string;
      page_number: number | null;
      section: string | null;
      excerpt: string;
      content_hash: string;
      source_type: WorkpaperEvidenceBinding["sourceType"];
      jurisdiction: string;
      effective_from: Date | null;
      effective_to: Date | null;
      source_publisher: string | null;
      source_uri: string | null;
      acquired_at: Date | null;
    }>
  >`
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
      const actual: WorkpaperEvidenceBinding = {
        id: row.id,
        documentName: row.document_name,
        page: row.page_number,
        section: row.section,
        excerpt: row.excerpt,
        contentHash: row.content_hash,
        sourceType: row.source_type,
        jurisdiction: row.jurisdiction,
        effectiveFrom: row.effective_from?.toISOString() ?? null,
        effectiveTo: row.effective_to?.toISOString() ?? null,
        sourcePublisher: row.source_publisher,
        sourceUri: row.source_uri,
        acquiredAt: row.acquired_at?.toISOString() ?? null,
      };
      return (
        expected !== undefined &&
        workpaperEvidenceBindingMatches(expected, actual)
      );
    })
  );
}

async function decideWorkpaper(input: WorkpaperInput) {
  const identity = await verifiedIdentity(input);
  return sql.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${identity.tenantId}, true)`;
    const actor = await resolveReviewer(
      transaction,
      identity,
      input.expectedActor,
    );
    verifyApprovalToken(input.approvalToken, {
      actorId: actor.id,
      targetId: input.targetId,
      artifactHash: input.artifactHash,
      decision: input.decision,
    });
    const artifacts = await transaction<
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
      WHERE approval.tenant_id = ${actor.tenantId}
        AND approval.target_id = ${input.targetId}
        AND approval.target_type = 'workpaper'
        AND approval.reviewer_id = ${actor.id}
        AND approval.status = 'PENDING'
        AND approval.expires_at > now()
    `;
    const artifact = artifacts[0];
    if (!artifact) return undefined;
    const currentHash = hashWorkpaperArtifact({
      targetId: input.targetId,
      matterId: artifact.matter_id,
      title: artifact.title,
      version: artifact.version,
      content: artifact.content,
      provenance: artifact.provenance,
    });
    if (
      currentHash !== input.artifactHash ||
      currentHash !== artifact.request_hash ||
      currentHash !== artifact.artifact_hash ||
      artifact.current_version !== artifact.target_version
    ) {
      return undefined;
    }
    if (
      !(await artifactEvidenceIsCurrent(
        transaction,
        actor.tenantId,
        artifact.matter_id,
        artifact.content,
      ))
    ) {
      return undefined;
    }
    const decisions = await transaction<
      Array<{ decision: "APPROVED" | "REJECTED" }>
    >`
      SELECT decision
      FROM decide_workpaper_review(
        ${actor.tenantId}::uuid, ${input.targetId}::uuid,
        ${actor.id}::uuid, ${input.decision}, ${input.note},
        ${input.artifactHash}, ${input.traceId}
      )
    `;
    return decisions[0]
      ? {
          ok: true as const,
          decision: decisions[0].decision,
          reviewer: actor.name,
          note: input.note,
        }
      : undefined;
  });
}

async function decideEvidence(input: EvidenceInput) {
  const identity = await verifiedIdentity(input);
  return sql.begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${identity.tenantId}, true)`;
    const actor = await resolveReviewer(
      transaction,
      identity,
      input.expectedActor,
    );
    const documents = await transaction<
      Array<{
        id: string;
        version: number;
        checksum_sha256: string;
        evidence_manifest_sha256: string | null;
        source_publisher: string | null;
        source_uri: string | null;
        acquired_at: Date | null;
      }>
    >`
      SELECT document.id::text, document.version, document.checksum_sha256,
             document.evidence_manifest_sha256, document.source_publisher,
             document.source_uri, document.acquired_at
      FROM documents document
      JOIN matters matter
        ON matter.tenant_id = document.tenant_id
       AND matter.id = document.matter_id
      WHERE document.tenant_id = ${actor.tenantId}
        AND document.id = ${input.documentId}
        AND document.status = 'INDEXED'
        AND document.evidence_status = 'PENDING'
        AND document.injection_scan_status = 'SAFE'
        AND matter.reviewer_id = ${actor.id}
        AND document.uploaded_by <> ${actor.id}
        AND document.checksum_sha256 = ${input.checksumSha256}
    `;
    const document = documents[0];
    if (!document) return undefined;
    const chunks = await transaction<
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
      WHERE tenant_id = ${actor.tenantId}
        AND document_id = ${input.documentId}
        AND document_version = ${document.version}
        AND is_current = true
      ORDER BY chunk_index
    `;
    const currentManifest = evidenceManifestHash({
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
    if (
      chunks.length === 0 ||
      currentManifest !== input.manifestSha256 ||
      document.evidence_manifest_sha256 !== input.manifestSha256
    ) {
      return undefined;
    }
    const decisions = await transaction<Array<{ document_id: string }>>`
      SELECT document_id::text
      FROM decide_document_evidence(
        ${actor.tenantId}::uuid, ${input.documentId}::uuid,
        ${actor.id}::uuid, ${input.decision}, ${input.checksumSha256},
        ${document.version}, ${input.manifestSha256}, ${input.traceId}
      )
    `;
    return decisions[0]
      ? { ok: true as const, documentId: decisions[0].document_id }
      : undefined;
  });
}

const server = createReviewerHttpServer({
  sharedSecret: sharedSecret!,
  healthCheck: async () => {
    await sql`SELECT 1`;
  },
  issueWorkpaperTokens,
  decideWorkpaper,
  decideEvidence,
});

async function shutdown(signal: string) {
  logReviewEvent("review.service_stopping", { signal });
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}

export function startReviewer() {
  const port = Number(process.env.PORT ?? "3100");
  server.listen(port, "0.0.0.0", () =>
    logReviewEvent("review.service_started", { port, outcome: "SUCCESS" }),
  );
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
