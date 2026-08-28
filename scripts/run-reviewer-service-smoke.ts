import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import {
  createReviewServiceEnvelope,
  createReviewServiceRequestMetadata,
  openReviewServiceEnvelope,
  reviewServiceContext,
} from "../src/lib/review/service-crypto.ts";
import { hashWorkpaperArtifact } from "../src/lib/workpapers/artifact.ts";
import { evidenceManifestHash } from "../src/lib/documents/evidence-manifest.ts";

const ownerUrl = process.env.TEST_DATABASE_OWNER_URL;
const reviewerDatabaseUrl = process.env.REVIEW_DATABASE_URL;
if (!ownerUrl || !reviewerDatabaseUrl) {
  throw new Error(
    "TEST_DATABASE_OWNER_URL and REVIEW_DATABASE_URL are required",
  );
}

const tenantId = "00000000-0000-4000-8000-000000000001";
const matterId = "00000000-0000-4000-8000-000000000301";
const analystId = "00000000-0000-4000-8000-000000000101";
const reviewerId = "00000000-0000-4000-8000-000000000102";
const runId = "00000000-0000-4000-8000-000000000903";
const targetId = "00000000-0000-4000-8000-000000000643";
const approvalId = "00000000-0000-4000-8000-000000000644";
const evidenceDocumentId = "00000000-0000-4000-8000-000000000645";
const evidenceChunkId = "00000000-0000-4000-8000-000000000745";
const issuer = "http://127.0.0.1:3211";
const reviewerUrl = "http://127.0.0.1:3210";
const reviewAudience = "taxops-review-api-contract";
const reviewScope = "review:decide";
const requiredAcr = "urn:taxops:acr:mfa";
const clientId = "taxops-contract-web";
const sharedSecret = Buffer.alloc(32, 7).toString("base64url");
const approvalSecret = Buffer.alloc(32, 9).toString("base64url");
const owner = postgres(ownerUrl, { max: 1, prepare: false });
const executionId = randomUUID();
const workpaperDecisionTraceId = `tr_reviewer_exactly_once_${executionId}`;
const evidenceDecisionTraceId = `tr_reviewer_evidence_once_${executionId}`;

type RequestMetadata = { timestamp: string; nonce: string };

async function invoke(
  path: string,
  payload: unknown,
  metadata: RequestMetadata = createReviewServiceRequestMetadata(),
) {
  const method = "POST";
  const body = createReviewServiceEnvelope(
    sharedSecret,
    payload,
    reviewServiceContext({ method, path, ...metadata, direction: "request" }),
  );
  const response = await fetch(new URL(path, reviewerUrl), {
    method,
    redirect: "error",
    headers: {
      "content-type": "application/vnd.taxops.encrypted+json",
      "x-taxops-timestamp": metadata.timestamp,
      "x-taxops-nonce": metadata.nonce,
    },
    body,
  });
  const responseText = await response.text();
  const encrypted = response.headers
    .get("content-type")
    ?.startsWith("application/vnd.taxops.encrypted+json");
  return {
    status: response.status,
    value: encrypted
      ? openReviewServiceEnvelope(
          sharedSecret,
          responseText,
          reviewServiceContext({
            method,
            path,
            ...metadata,
            direction: "response",
            status: response.status,
          }),
        )
      : JSON.parse(responseText),
  };
}

async function signAccessToken(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  overrides: {
    subject?: string;
    tenantId?: string;
    audience?: string;
    scope?: string;
    acr?: string;
    client?: string;
    authTime?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    tenant_id: overrides.tenantId ?? tenantId,
    scope: overrides.scope ?? reviewScope,
    acr: overrides.acr ?? requiredAcr,
    azp: overrides.client ?? clientId,
    auth_time: overrides.authTime ?? now,
  })
    .setProtectedHeader({ alg: "RS256", kid: "reviewer-contract-key" })
    .setSubject(overrides.subject ?? "oidc|reviewer")
    .setIssuer(issuer)
    .setAudience(overrides.audience ?? reviewAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

async function waitForReviewer(child: ChildProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Reviewer process exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${reviewerUrl}/health`, {
        redirect: "error",
      });
      if (response.ok) return;
    } catch {
      // Startup races are expected until the child has bound its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Reviewer service did not become ready");
}

const evidenceText = "검토자 서비스가 승인할 소명자료 계약 본문입니다.";
const evidenceChecksum = createHash("sha256")
  .update(evidenceText)
  .digest("hex");
const evidenceManifest = evidenceManifestHash({
  documentId: evidenceDocumentId,
  version: 1,
  sourceChecksumSha256: evidenceChecksum,
  sourcePublisher: null,
  sourceUri: null,
  acquiredAt: null,
  chunks: [
    {
      id: evidenceChunkId,
      chunkIndex: 0,
      contentHash: evidenceChecksum,
      sourceType: "BUSINESS_RECORD",
      jurisdiction: "KR",
      effectiveFrom: null,
      effectiveTo: null,
    },
  ],
});
const evidenceBinding = {
  id: evidenceChunkId,
  documentName: "reviewer-evidence.txt",
  page: 1,
  section: "소명",
  excerpt: evidenceText,
  contentHash: evidenceChecksum,
  sourceType: "BUSINESS_RECORD" as const,
  jurisdiction: "KR",
  effectiveFrom: null,
  effectiveTo: null,
  sourcePublisher: null,
  sourceUri: null,
  acquiredAt: null,
};
const content = {
  conclusion: "검토자 서비스 HTTP 경계 계약입니다.",
  evidenceIds: [evidenceChunkId],
  evidence: [evidenceBinding],
  calculations: [],
};
const provenance = {
  runId,
  traceId: "tr_reviewer_service_contract",
  promptVersion: "contract.v1",
  retrieverVersion: "contract-rag.v1",
  taxReferenceDate: "2025-12-31T23:59:59+09:00",
};
const artifactHash = hashWorkpaperArtifact({
  targetId,
  matterId,
  title: "검토자 서비스 계약",
  version: 1,
  content,
  provenance,
});

let reviewer: ChildProcess | undefined;
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = await exportJWK(publicKey);
const jwksServer = createServer((request, response) => {
  if (request.url !== "/.well-known/jwks.json") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(
    JSON.stringify({
      keys: [
        {
          ...publicJwk,
          kid: "reviewer-contract-key",
          alg: "RS256",
          use: "sig",
        },
      ],
    }),
  );
});

try {
  await owner.begin(async (transaction) => {
    await transaction`SELECT set_config('session_replication_role', 'replica', true)`;
    await transaction`DELETE FROM approvals WHERE id = ${approvalId}`;
    await transaction`DELETE FROM document_chunks WHERE id = ${evidenceChunkId}`;
    await transaction`DELETE FROM documents WHERE id = ${evidenceDocumentId}`;
    await transaction`
      DELETE FROM workpaper_versions WHERE workpaper_id = ${targetId}
    `;
    await transaction`DELETE FROM workpapers WHERE id = ${targetId}`;
    await transaction`DELETE FROM agent_runs WHERE id = ${runId}`;
    await transaction`SELECT set_config('session_replication_role', 'origin', true)`;
    await transaction`
      INSERT INTO agent_runs (
        id, tenant_id, matter_id, actor_id, workflow_status, trace_id,
        model_id, prompt_version, retriever_version, policy_version,
        completed_at
      ) VALUES (
        ${runId}, ${tenantId}, ${matterId}, ${analystId}, 'AWAITING_REVIEW',
        'tr_reviewer_service_contract', 'contract-primary', 'contract.v1',
        'contract-rag.v1', 'contract-policy.v1', now()
      )
    `;
    await transaction`
      INSERT INTO workpapers (
        id, tenant_id, matter_id, title, current_version, created_by
      ) VALUES (
        ${targetId}, ${tenantId}, ${matterId}, '검토자 서비스 계약', 1,
        ${analystId}
      )
    `;
    await transaction`
      INSERT INTO workpaper_versions (
        tenant_id, workpaper_id, version, content, provenance, artifact_hash,
        created_by
      ) VALUES (
        ${tenantId}, ${targetId}, 1, ${transaction.json(content)},
        ${transaction.json(provenance)}, ${artifactHash}, ${analystId}
      )
    `;
    await transaction`
      INSERT INTO approvals (
        id, tenant_id, target_type, target_id, requested_by, reviewer_id,
        request_hash, target_version, expires_at
      ) VALUES (
        ${approvalId}, ${tenantId}, 'workpaper', ${targetId}, ${analystId},
        ${reviewerId}, ${artifactHash}, 1, now() + interval '1 hour'
      )
    `;
    await transaction`
      INSERT INTO documents (
        id, tenant_id, matter_id, object_key, original_name, normalized_name,
        mime_type, byte_size, checksum_sha256, status, evidence_status,
        evidence_manifest_sha256, pii_classification, source_type, version,
        uploaded_by, object_version_id, object_etag,
        object_checksum_sha256, injection_scan_status, injection_scan_model,
        injection_scan_threshold, injection_risk_score, injection_scanned_at
      ) VALUES (
        ${evidenceDocumentId}, ${tenantId}, ${matterId},
        's3://contract/clean/reviewer-evidence.txt', 'reviewer-evidence.txt',
        'reviewer-evidence.txt', 'text/plain', ${evidenceText.length},
        ${evidenceChecksum}, 'INDEXED', 'PENDING', ${evidenceManifest},
        'INTERNAL', 'BUSINESS_RECORD', 1, ${analystId},
        'reviewer-contract-version', 'reviewer-contract-etag',
        ${evidenceChecksum}, 'SAFE',
        'semantic-injection-contract.v1', 0.5, 0, now()
      )
    `;
    await transaction`
      INSERT INTO document_chunks (
        id, tenant_id, matter_id, document_id, document_version, chunk_index,
        page_number, section, char_start, char_end, content, content_hash,
        source_type, jurisdiction, is_current
      ) VALUES (
        ${evidenceChunkId}, ${tenantId}, ${matterId}, ${evidenceDocumentId},
        1, 0, 1, '소명', 0, ${evidenceText.length}, ${evidenceText},
        ${evidenceChecksum}, 'BUSINESS_RECORD', 'KR', true
      )
    `;
  });

  jwksServer.listen(3211, "127.0.0.1");
  await once(jwksServer, "listening");
  let childOutput = "";
  reviewer = spawn(
    process.execPath,
    ["--import", "tsx", "src/reviewer/index.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REVIEW_DATABASE_URL: reviewerDatabaseUrl,
        REVIEW_SERVICE_SHARED_SECRET: sharedSecret,
        APPROVAL_TOKEN_SECRET: approvalSecret,
        OIDC_ISSUER: issuer,
        OIDC_JWKS_URL: `${issuer}/.well-known/jwks.json`,
        OIDC_REVIEW_AUDIENCE: reviewAudience,
        OIDC_REVIEW_SCOPE: reviewScope,
        OIDC_REVIEW_REQUIRED_ACR: requiredAcr,
        OIDC_CLIENT_ID: clientId,
        PORT: "3210",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const collectOutput = (chunk: Buffer) => {
    childOutput = (childOutput + chunk.toString("utf8")).slice(-8_000);
  };
  reviewer.stdout?.on("data", collectOutput);
  reviewer.stderr?.on("data", collectOutput);
  try {
    await waitForReviewer(reviewer);
  } catch (error) {
    throw new Error(`${String(error)}\n${childOutput}`);
  }

  const validToken = await signAccessToken(privateKey);
  const actor = { tenantId, id: reviewerId, name: "이서윤" };
  const evidenceRequest = {
    identityToken: validToken,
    expectedActor: actor,
    documentId: evidenceDocumentId,
    decision: "APPROVED" as const,
    checksumSha256: evidenceChecksum,
    manifestSha256: evidenceManifest,
    traceId: evidenceDecisionTraceId,
  };
  assert.equal(
    (
      await invoke("/v1/decisions/evidence", {
        ...evidenceRequest,
        manifestSha256: "0".repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (await invoke("/v1/decisions/evidence", evidenceRequest)).status,
    200,
  );
  assert.equal(
    (await invoke("/v1/decisions/evidence", evidenceRequest)).status,
    409,
  );
  const evidenceRows = await owner<
    Array<{ evidence_status: string; decision_audits: number }>
  >`
    SELECT document.evidence_status,
           (SELECT count(*)::int FROM audit_events event
            WHERE event.tenant_id = document.tenant_id
              AND event.target_id = document.id::text
              AND event.action = 'DOCUMENT_EVIDENCE_APPROVED'
              AND event.trace_id = ${evidenceDecisionTraceId}) AS decision_audits
    FROM documents document
    WHERE document.id = ${evidenceDocumentId}
  `;
  assert.equal(evidenceRows.length, 1);
  assert.deepEqual(
    { ...evidenceRows[0] },
    {
      evidence_status: "APPROVED",
      decision_audits: 1,
    },
  );

  for (const invalidContent of [
    {
      conclusion: "근거가 없는 위조 산출물입니다.",
      evidenceIds: [],
      evidence: [],
      calculations: [],
    },
    {
      ...content,
      evidence: [
        {
          ...evidenceBinding,
          excerpt: "해시와 관계없는 위조 인용문입니다.",
        },
      ],
    },
  ]) {
    const invalidHash = hashWorkpaperArtifact({
      targetId,
      matterId,
      title: "검토자 서비스 계약",
      version: 1,
      content: invalidContent,
      provenance,
    });
    await owner.begin(async (transaction) => {
      await transaction`SELECT set_config('session_replication_role', 'replica', true)`;
      await transaction`
        UPDATE workpaper_versions
        SET content = ${transaction.json(invalidContent)},
            artifact_hash = ${invalidHash}
        WHERE tenant_id = ${tenantId} AND workpaper_id = ${targetId}
          AND version = 1
      `;
      await transaction`
        UPDATE approvals SET request_hash = ${invalidHash}
        WHERE id = ${approvalId}
      `;
      await transaction`SELECT set_config('session_replication_role', 'origin', true)`;
    });
    assert.equal(
      (
        await invoke("/v1/tokens/workpapers", {
          identityToken: validToken,
          expectedActor: actor,
          targetId,
          artifactHash: invalidHash,
        })
      ).status,
      409,
    );
  }
  await owner.begin(async (transaction) => {
    await transaction`SELECT set_config('session_replication_role', 'replica', true)`;
    await transaction`
      UPDATE workpaper_versions
      SET content = ${transaction.json(content)}, artifact_hash = ${artifactHash}
      WHERE tenant_id = ${tenantId} AND workpaper_id = ${targetId}
        AND version = 1
    `;
    await transaction`
      UPDATE approvals SET request_hash = ${artifactHash}
      WHERE id = ${approvalId}
    `;
    await transaction`SELECT set_config('session_replication_role', 'origin', true)`;
  });
  const tokenRequest = {
    identityToken: validToken,
    expectedActor: actor,
    targetId,
    artifactHash,
  };
  const replayMetadata = createReviewServiceRequestMetadata();
  const issued = await invoke(
    "/v1/tokens/workpapers",
    tokenRequest,
    replayMetadata,
  );
  assert.equal(
    issued.status,
    200,
    `Token issuance failed: ${JSON.stringify(issued.value)}\n${childOutput}`,
  );
  const issuedValue = issued.value as {
    tokens: { APPROVED: string; REJECTED: string };
  };
  assert.ok(issuedValue.tokens.APPROVED);
  assert.equal(
    (await invoke("/v1/tokens/workpapers", tokenRequest, replayMetadata))
      .status,
    400,
  );

  const invalidIdentityCases = [
    await signAccessToken(privateKey, { audience: "wrong-audience" }),
    await signAccessToken(privateKey, { scope: "openid profile" }),
    await signAccessToken(privateKey, { acr: "urn:taxops:acr:password" }),
    await signAccessToken(privateKey, {
      authTime: Math.floor(Date.now() / 1_000) - 901,
    }),
    await signAccessToken(privateKey, { client: "attacker-client" }),
    await signAccessToken(privateKey, {
      tenantId: "00000000-0000-4000-8000-000000000999",
    }),
  ];
  for (const identityToken of invalidIdentityCases) {
    assert.equal(
      (
        await invoke("/v1/tokens/workpapers", {
          ...tokenRequest,
          identityToken,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await invoke("/v1/tokens/workpapers", {
        ...tokenRequest,
        identityToken: await signAccessToken(privateKey, {
          subject: "oidc|analyst",
        }),
        expectedActor: { tenantId, id: analystId, name: "곽현" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await invoke("/v1/tokens/workpapers", {
        ...tokenRequest,
        artifactHash: "0".repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await invoke("/v1/decisions/workpapers", {
        identityToken: validToken,
        expectedActor: actor,
        targetId,
        decision: "REJECTED",
        note: "다른 action에 묶인 토큰은 거부해야 합니다.",
        artifactHash,
        traceId: "tr_reviewer_action_mismatch",
        approvalToken: issuedValue.tokens.APPROVED,
      })
    ).status,
    400,
  );

  const decisionRequest = {
    identityToken: validToken,
    expectedActor: actor,
    targetId,
    decision: "APPROVED" as const,
    note: "정확한 산출물과 검토자 신원을 확인했습니다.",
    artifactHash,
    traceId: workpaperDecisionTraceId,
    approvalToken: issuedValue.tokens.APPROVED,
  };
  assert.equal(
    (await invoke("/v1/decisions/workpapers", decisionRequest)).status,
    200,
  );
  assert.equal(
    (await invoke("/v1/decisions/workpapers", decisionRequest)).status,
    409,
  );
  const rows = await owner<
    Array<{
      status: string;
      workflow_status: string;
      decision_audits: number;
    }>
  >`
    SELECT approval.status,
           (SELECT run.workflow_status::text FROM agent_runs run
            WHERE run.id = ${runId}) AS workflow_status,
           (SELECT count(*)::int FROM audit_events event
            WHERE event.tenant_id = approval.tenant_id
              AND event.target_id = approval.target_id::text
              AND event.action = 'WORKPAPER_APPROVED'
              AND event.trace_id = ${workpaperDecisionTraceId}) AS decision_audits
    FROM approvals approval
    WHERE approval.id = ${approvalId}
  `;
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      status: "APPROVED",
      workflow_status: "APPROVED",
      decision_audits: 1,
    },
  );
} finally {
  if (reviewer && reviewer.exitCode === null) {
    reviewer.kill("SIGTERM");
    await Promise.race([
      once(reviewer, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  jwksServer.close();
  await owner.begin(async (transaction) => {
    await transaction`SELECT set_config('session_replication_role', 'replica', true)`;
    await transaction`DELETE FROM approvals WHERE id = ${approvalId}`;
    await transaction`DELETE FROM document_chunks WHERE id = ${evidenceChunkId}`;
    await transaction`DELETE FROM documents WHERE id = ${evidenceDocumentId}`;
    await transaction`
      DELETE FROM workpaper_versions WHERE workpaper_id = ${targetId}
    `;
    await transaction`DELETE FROM workpapers WHERE id = ${targetId}`;
    await transaction`DELETE FROM agent_runs WHERE id = ${runId}`;
  });
  await owner.end({ timeout: 2 });
}
