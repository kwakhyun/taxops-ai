import type {
  AuditEvent,
  DocumentRecord,
  EvidenceReviewPreview,
  Matter,
  MatterAnalysis,
  SessionUser,
} from "@/lib/domain/types";
import {
  auditEvents as seededAuditEvents,
  demoUsers,
  documents as seededDocuments,
  evidence,
  agentRuns,
  matters as seededMatters,
  workflowSteps,
} from "@/lib/domain/fixtures";
import { hashAuditEvent } from "@/lib/audit/hash-chain";
import {
  hashWorkpaperArtifact,
  type ReviewRequest,
} from "@/lib/workpapers/artifact";
import { resolveTenantAiPolicy } from "@/lib/security/ai-policy";
import { evidenceManifestHash } from "@/lib/documents/evidence-manifest";
import type { CreateMatterInput } from "@/lib/contracts/cases";

const demoReviewTargetId = "00000000-0000-4000-8000-000000000401";
const demoReviewerId = "00000000-0000-4000-8000-000000000102";
const demoEvidenceReviewChecksum =
  "4d8c93f1e65088e95de2fbf19f46f6328262690285cf3dc7a9e245a55e14720e";
const demoEvidenceReviewChunks = [
  {
    id: "chunk_evidence_review_01",
    chunkIndex: 0,
    page: 1,
    section: "거래 목적",
    excerpt:
      "거래처 두 곳과의 식사비는 2025년 11월 제품 도입 협의를 위한 지출이며 참석자와 회의 목적을 별첨했습니다.",
    contentHash:
      "3e90e9e1086be4a1bb2ac810829ca504675809bfddfe1949380b76f974ad228d",
    sourceType: "BUSINESS_RECORD" as const,
    jurisdiction: "KR",
    effectiveFrom: null,
    effectiveTo: null,
  },
  {
    id: "chunk_evidence_review_02",
    chunkIndex: 1,
    page: 1,
    section: "첨부 확인",
    excerpt:
      "법인카드 영수증 2건과 참석자 명단, 회의 메모가 원장 전표 번호 384 및 391에 연결되어 있습니다.",
    contentHash:
      "91679ea8e59ddd6342b64a03761a815deeda998cbc186fde4be0171596e561de",
    sourceType: "BUSINESS_RECORD" as const,
    jurisdiction: "KR",
    effectiveFrom: null,
    effectiveTo: null,
  },
] as const;
const demoEvidenceReviewManifest = evidenceManifestHash({
  documentId: "doc_evidence_review",
  version: 1,
  sourceChecksumSha256: demoEvidenceReviewChecksum,
  chunks: demoEvidenceReviewChunks,
});
const demoReviewContent = {
  conclusion:
    "신고서 초안의 불공제 매입세액과 원장 분석 결과 사이에 740,000원 차이가 있습니다.",
  calculation: {
    ledgerAmount: 1_842_000,
    returnAmount: 1_102_000,
    difference: 740_000,
  },
  calculations: [
    {
      taxableTotal: 18_420_000,
      rate: 0.1,
      vat: 1_842_000,
      formula: "18420000 × 0.1",
    },
  ],
  evidenceIds: ["ev_vat_001", "ev_ledger_019", "ev_return_007"],
  evidence: evidence.map((item) => ({
    id: item.id,
    documentName: item.documentName,
    page: item.page,
    section: item.section,
    excerpt: item.excerpt,
    contentHash: item.contentHash,
    sourceType: item.sourceType,
    jurisdiction: item.jurisdiction,
    effectiveFrom: item.effectiveFrom,
    effectiveTo: item.effectiveTo,
    sourcePublisher: item.sourcePublisher,
    sourceUri: item.sourceUri,
    acquiredAt: item.acquiredAt,
  })),
  openItems: ["거래 2건의 업무 관련성 소명 확인"],
};
const demoReviewProvenance = {
  promptVersion: "tax-memo.v1.3.0",
  retrieverVersion: "hybrid-rag.v1.2.0",
  traceId: "tr_7a81f4c2",
  taxReferenceDate: "2025-12-31T23:59:59+09:00",
};
const demoReviewHash = hashWorkpaperArtifact({
  targetId: demoReviewTargetId,
  matterId: "vat-2025-q4",
  title: "매입세액 불공제 검토 메모",
  version: 1,
  content: demoReviewContent,
  provenance: demoReviewProvenance,
});

function buildDemoReview(): ReviewRequest {
  return {
    targetId: demoReviewTargetId,
    matterId: "vat-2025-q4",
    client: "한빛테크 주식회사",
    taxType: "부가가치세",
    period: "2025년 2기 확정",
    title: "매입세액 불공제 검토 메모",
    version: 1,
    content: demoReviewContent,
    provenance: demoReviewProvenance,
    requestedBy: "곽현",
    reviewer: "이서윤",
    status: "PENDING",
    expiresAt: "2099-01-01T00:00:00.000Z",
    requestHash: demoReviewHash,
    artifactHash: demoReviewHash,
    stale: false,
  };
}

function buildSeededAuditEvents() {
  let previousHash = "0".repeat(64);
  const oldestFirst = seededAuditEvents.toReversed().map((event) => {
    const hash = hashAuditEvent(previousHash, {
      tenantId: "tenant_hanul",
      actorId: event.actor,
      action: event.action,
      targetType: "demo-resource",
      targetId: event.target,
      outcome: event.outcome,
      occurredAt: event.occurredAt,
      traceId: event.traceId,
    });
    const normalized: AuditEvent = {
      ...event,
      tenantId: "tenant_hanul",
      actorId: event.actor,
      targetType: "demo-resource",
      metadata: {},
      prevHash: previousHash,
      hash,
    };
    previousHash = hash;
    return normalized;
  });
  return oldestFirst.toReversed();
}

export interface DemoJob {
  id: string;
  tenantId: string;
  type: "DOCUMENT_INGESTION" | "NOTIFICATION";
  status:
    | "QUEUED"
    | "RUNNING"
    | "RETRYING"
    | "SUCCEEDED"
    | "FAILED"
    | "DEAD"
    | "CANCELLED";
  progress: number;
  idempotencyKey: string;
  resourceId: string;
  createdAt: string;
}

interface DemoStore {
  matters: Matter[];
  documents: DocumentRecord[];
  jobs: DemoJob[];
  auditEvents: AuditEvent[];
  idempotency: Map<string, string>;
  reviewDecisions: Map<
    string,
    { decision: "APPROVED" | "REJECTED"; reviewer: string; note: string }
  >;
  reviews: ReviewRequest[];
}

declare global {
  var __taxopsDemoStore: DemoStore | undefined;
}

export function resetDemoStoreForTests() {
  if (
    process.env.NODE_ENV === "production" ||
    process.env.E2E_RESET_ENABLED !== "true"
  ) {
    throw new Error("Demo reset is available only to the local E2E harness");
  }
  globalThis.__taxopsDemoStore = undefined;
}

function getStore(): DemoStore {
  globalThis.__taxopsDemoStore ??= {
    matters: structuredClone(seededMatters),
    documents: structuredClone(seededDocuments),
    jobs: [],
    auditEvents: buildSeededAuditEvents(),
    idempotency: new Map(),
    reviewDecisions: new Map(),
    reviews: [buildDemoReview()],
  };
  const store = globalThis.__taxopsDemoStore;
  // Keep local HMR sessions compatible when the in-memory demo schema evolves.
  store.reviews ??= [buildDemoReview()];
  const evidenceReviewDocument = seededDocuments.find(
    (document) => document.id === "doc_evidence_review",
  );
  if (
    evidenceReviewDocument &&
    !store.documents.some(
      (document) => document.id === evidenceReviewDocument.id,
    )
  ) {
    store.documents.push(structuredClone(evidenceReviewDocument));
  }
  return store;
}

export function listMatters(user: SessionUser) {
  if (user.tenantId !== "tenant_hanul") return [];
  return structuredClone(getStore().matters);
}

export function getTenantAiPolicy(user: SessionUser) {
  return resolveTenantAiPolicy(
    user.tenantId === "tenant_hanul",
    {
      outboundPiiMode: "REDACT",
      maxExcerptChars: 1_500,
    },
    {
      tenantDataRegion: "ap-northeast-2",
      providerDataRegion: "ap-northeast-2",
    },
  );
}

export function listReviewers(user: SessionUser) {
  if (user.tenantId !== "tenant_hanul") return [];
  return Object.values(demoUsers)
    .filter(
      (candidate) => candidate.role !== "ANALYST" && candidate.id !== user.id,
    )
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      role: candidate.role as "REVIEWER" | "ADMIN",
    }));
}

export function startAgentRun() {
  return `run_${crypto.randomUUID()}`;
}

export function finishAgentRun() {
  return undefined;
}

export function assertTenantAiSpendBudget() {
  return undefined;
}

export function recordRetrievalEvent() {
  return undefined;
}

export function recordToolCall() {
  return undefined;
}

export function createWorkpaperDraft(input: {
  tenantId: string;
  matterId: string;
  actorId: string;
  runId: string;
  traceId: string;
  taxReferenceDate: string;
  title: string;
  conclusion: string;
  evidenceIds: string[];
  evidenceHashes: Record<string, string | undefined>;
  calculations: Array<Record<string, string | number>>;
}) {
  const matter = getStore().matters.find((item) => item.id === input.matterId);
  const actor = Object.values(demoUsers).find(
    (candidate) => candidate.id === input.actorId,
  );
  if (
    !matter ||
    !actor ||
    input.tenantId !== "tenant_hanul" ||
    matter.reviewer === actor.name
  ) {
    throw new Error("Matter is outside the active demo tenant");
  }
  const uniqueEvidenceIds = [...new Set(input.evidenceIds)];
  const scopedEvidence = evidence.filter(
    (item) =>
      item.tenantId === input.tenantId &&
      item.matterId === input.matterId &&
      uniqueEvidenceIds.includes(item.id),
  );
  if (
    uniqueEvidenceIds.length === 0 ||
    uniqueEvidenceIds.length !== input.evidenceIds.length ||
    scopedEvidence.length !== uniqueEvidenceIds.length ||
    scopedEvidence.some(
      (item) => input.evidenceHashes[item.id] !== item.contentHash,
    )
  ) {
    throw new Error("Evidence changed after independent verification");
  }
  const targetId = crypto.randomUUID();
  const content = {
    conclusion: input.conclusion,
    evidenceIds: uniqueEvidenceIds,
    evidence: scopedEvidence.map((item) => ({
      id: item.id,
      documentName: item.documentName,
      page: item.page,
      section: item.section,
      excerpt: item.excerpt,
      contentHash: item.contentHash,
      sourceType: item.sourceType,
      jurisdiction: item.jurisdiction,
      effectiveFrom: item.effectiveFrom,
      effectiveTo: item.effectiveTo,
      sourcePublisher: item.sourcePublisher,
      sourceUri: item.sourceUri,
      acquiredAt: item.acquiredAt,
    })),
    calculations: input.calculations,
    openItems: ["Reviewer의 세무 판단과 계산 입력 확인"],
  };
  const provenance = {
    runId: input.runId,
    traceId: input.traceId,
    promptVersion: "1.3.0",
    retrieverVersion: "hybrid-rag.v1.2.0",
    taxReferenceDate: input.taxReferenceDate,
  };
  const artifactHash = hashWorkpaperArtifact({
    targetId,
    matterId: matter.id,
    title: input.title,
    version: 1,
    content,
    provenance,
  });
  getStore().reviews.unshift({
    targetId,
    matterId: matter.id,
    client: matter.client,
    taxType: matter.taxType,
    period: matter.period,
    title: input.title,
    version: 1,
    content,
    provenance,
    requestedBy:
      Object.values(demoUsers).find((user) => user.id === input.actorId)
        ?.name ?? "Tax Analyst",
    reviewer: matter.reviewer,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    requestHash: artifactHash,
    artifactHash,
    stale: false,
  });
  return { targetId, artifactHash, version: 1 };
}

export function listDocuments(user: SessionUser, matterId?: string) {
  if (user.tenantId !== "tenant_hanul") return [];
  const items = matterId
    ? getStore().documents.filter((document) => document.matterId === matterId)
    : getStore().documents;
  return structuredClone(
    items.map((document) => {
      const matter = getStore().matters.find(
        (candidate) => candidate.id === document.matterId,
      );
      return {
        ...document,
        evidenceReviewable:
          document.status === "INDEXED" &&
          document.evidenceStatus === "PENDING" &&
          matter?.reviewer === user.name &&
          document.uploadedBy !== user.name,
      };
    }),
  );
}

export function getDocumentEvidenceReview(
  user: SessionUser,
  documentId: string,
): EvidenceReviewPreview | undefined {
  const document = getStore().documents.find((item) => item.id === documentId);
  const matter = document
    ? getStore().matters.find((item) => item.id === document.matterId)
    : undefined;
  if (
    user.tenantId !== "tenant_hanul" ||
    user.id !== demoReviewerId ||
    !document ||
    !matter ||
    matter.reviewer !== user.name ||
    document.uploadedBy === user.name ||
    document.id !== "doc_evidence_review" ||
    document.status !== "INDEXED" ||
    document.evidenceStatus !== "PENDING"
  ) {
    return undefined;
  }
  return {
    documentId: document.id,
    matterId: document.matterId,
    name: document.name,
    version: 1,
    uploadedBy: document.uploadedBy,
    checksumSha256: demoEvidenceReviewChecksum,
    manifestSha256: demoEvidenceReviewManifest,
    chunkCount: 2,
    sourcePublisher: null,
    sourceUri: null,
    acquiredAt: null,
    previewChunks: demoEvidenceReviewChunks.map(({ chunkIndex, ...chunk }) => {
      void chunkIndex;
      return chunk;
    }),
  };
}

export function setDocumentEvidenceDecision(
  user: SessionUser,
  documentId: string,
  decision: "APPROVED" | "REJECTED",
  expectedChecksumSha256: string,
  expectedManifestSha256: string,
  traceId?: string,
) {
  const document = getStore().documents.find((item) => item.id === documentId);
  const matter = document
    ? getStore().matters.find((item) => item.id === document.matterId)
    : undefined;
  if (
    user.tenantId !== "tenant_hanul" ||
    user.id !== demoReviewerId ||
    !document ||
    !matter ||
    matter.reviewer !== user.name ||
    document.uploadedBy === user.name ||
    document.id !== "doc_evidence_review" ||
    expectedChecksumSha256 !== demoEvidenceReviewChecksum ||
    expectedManifestSha256 !== demoEvidenceReviewManifest ||
    document.status !== "INDEXED" ||
    document.evidenceStatus !== "PENDING"
  ) {
    return undefined;
  }
  document.evidenceStatus = decision;
  document.updatedAt = "방금 전";
  if (traceId) {
    appendAuditEvent(user, {
      action:
        decision === "APPROVED"
          ? "DOCUMENT_EVIDENCE_APPROVED"
          : "DOCUMENT_EVIDENCE_REJECTED",
      targetType: "document",
      targetId: document.id,
      outcome: "SUCCESS",
      traceId,
      metadata: {
        checksumSha256: expectedChecksumSha256,
        manifestSha256: expectedManifestSha256,
      },
    });
  }
  return structuredClone(document);
}

export function findMatter(user: SessionUser, id: string) {
  if (user.tenantId !== "tenant_hanul") return undefined;
  const matter = getStore().matters.find((item) => item.id === id);
  return matter ? structuredClone(matter) : undefined;
}

export function getMatterAnalysis(
  user: SessionUser,
  matterId: string,
): MatterAnalysis | undefined {
  if (user.tenantId !== "tenant_hanul") return undefined;
  const latestRun = agentRuns.find((run) => run.matterId === matterId);
  if (!latestRun) return undefined;
  const review = getStore().reviews.find((item) => item.matterId === matterId);
  return {
    latestRun: structuredClone(latestRun),
    workflowSteps: structuredClone(workflowSteps),
    workpaper: review
      ? {
          title: review.title,
          conclusion:
            typeof review.content.conclusion === "string"
              ? review.content.conclusion
              : "저장된 결론이 없습니다.",
          amountKrw: 740_000,
          reviewStatus: review.status,
          evidence: evidence.map((item) => ({
            id: item.id,
            documentName: item.documentName,
            page: item.page,
            section: item.section || null,
            excerpt: item.excerpt,
            contentHash: item.contentHash,
          })),
        }
      : undefined,
  };
}

export function createMatter(
  user: SessionUser,
  input: CreateMatterInput,
  traceId?: string,
) {
  const reviewer = Object.values(demoUsers).find(
    (candidate) =>
      candidate.id === input.reviewerId &&
      candidate.tenantId === user.tenantId &&
      candidate.id !== user.id &&
      candidate.role !== "ANALYST",
  );
  if (!reviewer) {
    throw new Error("현재 워크스페이스에서 Reviewer를 찾을 수 없습니다.");
  }
  const id = `matter-${crypto.randomUUID().slice(0, 8)}`;
  const matter: Matter = {
    id,
    client: input.client,
    taxType: input.taxType,
    period: input.period,
    summary: input.summary,
    dueDate: input.dueDate,
    reviewer: reviewer.name,
    owner: user.name,
    status: "IN_REVIEW",
    risk: "LOW",
    progress: 8,
    openFindings: 0,
    evidenceCoverage: 0,
    updatedAt: "방금 전",
  };
  getStore().matters.unshift(matter);
  if (traceId) {
    appendAuditEvent(user, {
      action: "MATTER_CREATED",
      targetType: "matter",
      targetId: matter.id,
      outcome: "SUCCESS",
      traceId,
    });
  }
  return structuredClone(matter);
}

export function enqueueDocument(
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
  if (
    input.sourceType === "TAX_AUTHORITY" &&
    (user.role !== "ADMIN" ||
      !input.sourcePublisher ||
      !input.sourceUri ||
      !input.acquiredAt)
  ) {
    throw new Error(
      "공식 세무 자료는 관리자만 검증 가능한 provenance와 함께 등록할 수 있습니다.",
    );
  }
  const store = getStore();
  const finalize = (result: {
    document: DocumentRecord;
    job: DemoJob;
    deduplicated: boolean;
  }) => {
    if (input.traceId) {
      appendAuditEvent(user, {
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
  };
  const scopedKey = `${user.tenantId}:${input.idempotencyKey}`;
  const existingDocumentId = store.idempotency.get(scopedKey);
  if (existingDocumentId) {
    const existingDocument = store.documents.find(
      (item) => item.id === existingDocumentId,
    )!;
    if (
      existingDocument.matterId !== input.matterId ||
      existingDocument.name !== input.name ||
      existingDocument.sourceType !== input.sourceType
    ) {
      throw new Error(
        "같은 Idempotency-Key를 다른 업로드 또는 출처 분류에 재사용할 수 없습니다.",
      );
    }
    return finalize({
      document: structuredClone(existingDocument),
      job: structuredClone(
        store.jobs.find((item) => item.resourceId === existingDocumentId)!,
      ),
      deduplicated: true,
    });
  }

  const document: DocumentRecord = {
    id: `doc_${crypto.randomUUID().slice(0, 12)}`,
    matterId: input.matterId,
    name: input.name,
    kind:
      input.mimeType.includes("spreadsheet") || input.mimeType === "text/csv"
        ? "원장"
        : "증빙",
    size: `${(input.size / 1024 / 1024).toFixed(2)} MB`,
    status: "QUARANTINED",
    evidenceStatus: "PENDING",
    pages: 0,
    chunks: 0,
    piiClass: "RESTRICTED",
    uploadedBy: user.name,
    updatedAt: "방금 전",
    checksum: `sha256:${input.checksum.slice(0, 8)}…${input.checksum.slice(-4)}`,
    sourceType: input.sourceType,
  };
  const job: DemoJob = {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    tenantId: user.tenantId,
    type: "DOCUMENT_INGESTION",
    status: "QUEUED",
    progress: 0,
    idempotencyKey: input.idempotencyKey,
    resourceId: document.id,
    createdAt: new Date().toISOString(),
  };
  store.documents.unshift(document);
  store.jobs.unshift(job);
  store.idempotency.set(scopedKey, document.id);
  return finalize({
    document: structuredClone(document),
    job: structuredClone(job),
    deduplicated: false,
  });
}

export function getJob(user: SessionUser, id: string) {
  const job = getStore().jobs.find(
    (item) => item.id === id && item.tenantId === user.tenantId,
  );
  return job ? structuredClone(job) : undefined;
}

export function listAuditEvents(user: SessionUser) {
  if (user.tenantId !== "tenant_hanul") return [];
  return structuredClone(getStore().auditEvents);
}

export function listReviewRequests(user: SessionUser) {
  if (user.tenantId !== "tenant_hanul" || user.id !== demoReviewerId) return [];
  return structuredClone(getStore().reviews);
}

export function getReviewRequest(user: SessionUser, targetId: string) {
  if (user.tenantId !== "tenant_hanul" || user.id !== demoReviewerId) {
    return undefined;
  }
  const review = getStore().reviews.find((item) => item.targetId === targetId);
  return review ? structuredClone(review) : undefined;
}

export function getReviewArtifactHash(user: SessionUser, targetId: string) {
  const review = getReviewRequest(user, targetId);
  return review?.status === "PENDING" && !review.stale
    ? review.artifactHash
    : undefined;
}

export function setReviewDecision(
  user: SessionUser,
  targetId: string,
  input: {
    decision: "APPROVED" | "REJECTED";
    note: string;
    artifactHash: string;
    traceId: string;
  },
) {
  const store = getStore();
  const review = store.reviews.find((item) => item.targetId === targetId);
  if (
    user.id !== demoReviewerId ||
    !review ||
    review.status !== "PENDING" ||
    review.artifactHash !== input.artifactHash
  ) {
    return undefined;
  }
  const decision = { ...input, reviewer: user.name };
  review.status = input.decision;
  review.decisionNote = input.note;
  store.reviewDecisions.set(targetId, decision);
  appendAuditEvent(user, {
    action:
      input.decision === "APPROVED"
        ? "WORKPAPER_APPROVED"
        : "WORKPAPER_REJECTED",
    targetType: "workpaper",
    targetId,
    outcome: "SUCCESS",
    traceId: input.traceId,
  });
  return structuredClone(decision);
}

export function getReviewDecision(targetId: string) {
  const decision = getStore().reviewDecisions.get(targetId);
  return decision ? structuredClone(decision) : undefined;
}

export function appendAuditEvent(
  user: SessionUser,
  input: {
    action: string;
    targetType: string;
    targetId: string;
    outcome: AuditEvent["outcome"];
    traceId: string;
    metadata?: Record<string, string | number | boolean | null>;
  },
) {
  const store = getStore();
  const previousHash = store.auditEvents[0]?.hash ?? "0".repeat(64);
  const occurredAt = new Date().toISOString();
  const hash = hashAuditEvent(previousHash, {
    tenantId: user.tenantId,
    actorId: user.id,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    outcome: input.outcome,
    occurredAt,
    traceId: input.traceId,
    metadata: input.metadata,
  });
  const event: AuditEvent = {
    id: `audit_${crypto.randomUUID().slice(0, 12)}`,
    tenantId: user.tenantId,
    actorId: user.id,
    targetType: input.targetType,
    metadata: input.metadata ?? {},
    occurredAt,
    actor: user.name,
    action: input.action,
    target: input.targetId,
    outcome: input.outcome,
    traceId: input.traceId,
    ipMasked: "not-recorded",
    prevHash: previousHash,
    hash,
  };
  store.auditEvents.unshift(event);
  return structuredClone(event);
}
