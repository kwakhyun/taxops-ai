import "server-only";

import * as demo from "./demo-store";
import * as production from "./postgres-store";
import type { CreateMatterInput } from "@/lib/contracts/cases";
import type { SessionUser } from "@/lib/domain/types";
import { verifyAuditChain } from "@/lib/audit/hash-chain";

function adapter() {
  return process.env.DATABASE_URL ? production : demo;
}

export async function listMatters(user: SessionUser) {
  return adapter().listMatters(user);
}

export async function getTenantAiPolicy(user: SessionUser) {
  return adapter().getTenantAiPolicy(user);
}

export async function listReviewers(user: SessionUser) {
  return adapter().listReviewers(user);
}

export async function startAgentRun(
  user: SessionUser,
  input: Parameters<typeof production.startAgentRun>[1],
) {
  return adapter().startAgentRun(user, input);
}

export async function finishAgentRun(
  user: SessionUser,
  input: Parameters<typeof production.finishAgentRun>[1],
) {
  return adapter().finishAgentRun(user, input);
}

export async function assertTenantAiSpendBudget(
  user: SessionUser,
  monthlyBudgetKrw: number,
) {
  return adapter().assertTenantAiSpendBudget(user, monthlyBudgetKrw);
}

export async function recordRetrievalEvent(
  input: Parameters<typeof production.recordRetrievalEvent>[0],
) {
  return adapter().recordRetrievalEvent(input);
}

export async function recordToolCall(
  input: Parameters<typeof production.recordToolCall>[0],
) {
  return adapter().recordToolCall(input);
}

export async function createWorkpaperDraft(
  input: Parameters<typeof production.createWorkpaperDraft>[0],
) {
  return adapter().createWorkpaperDraft(input);
}

export async function findMatter(user: SessionUser, id: string) {
  return adapter().findMatter(user, id);
}

export async function getMatterAnalysis(user: SessionUser, matterId: string) {
  return adapter().getMatterAnalysis(user, matterId);
}

export async function listDocuments(user: SessionUser, matterId?: string) {
  return adapter().listDocuments(user, matterId);
}

export async function getDocumentDownload(
  user: SessionUser,
  documentId: string,
) {
  return adapter().getDocumentDownload(user, documentId);
}

export async function getDocumentEvidenceReview(
  user: SessionUser,
  documentId: string,
) {
  return adapter().getDocumentEvidenceReview(user, documentId);
}

export async function setDocumentEvidenceDecision(
  user: SessionUser,
  documentId: string,
  decision: "APPROVED" | "REJECTED",
  expectedChecksumSha256: string,
  expectedManifestSha256: string,
  traceId?: string,
) {
  return adapter().setDocumentEvidenceDecision(
    user,
    documentId,
    decision,
    expectedChecksumSha256,
    expectedManifestSha256,
    traceId,
  );
}

export async function createMatter(
  user: SessionUser,
  input: CreateMatterInput,
  traceId?: string,
) {
  return adapter().createMatter(user, input, traceId);
}

export async function enqueueDocument(
  user: SessionUser,
  input: Parameters<typeof demo.enqueueDocument>[1],
) {
  return adapter().enqueueDocument(user, input);
}

export async function getJob(user: SessionUser, id: string) {
  return adapter().getJob(user, id);
}

export async function listAuditEvents(user: SessionUser) {
  return adapter().listAuditEvents(user);
}

export async function getAuditIntegrity(user: SessionUser) {
  if (process.env.DATABASE_URL) return production.getAuditIntegrity(user);

  const events = await listAuditEvents(user);
  const complete = events.every(
    (event) =>
      event.tenantId && event.actorId && event.targetType && event.metadata,
  );
  const valid =
    complete &&
    verifyAuditChain(
      events.map((event) => ({
        tenantId: event.tenantId!,
        actorId: event.actorId!,
        action: event.action,
        targetType: event.targetType!,
        targetId: event.target,
        outcome: event.outcome,
        occurredAt: event.occurredAt,
        traceId: event.traceId,
        metadata: event.metadata,
        previousHash: event.prevHash,
        hash: event.hash,
      })),
    );
  return {
    valid,
    count: events.length,
    verifiedAt: new Date().toISOString(),
    rootPreviousHash: events.at(-1)?.prevHash ?? null,
    headHash: events[0]?.hash ?? null,
    scope: "full-chain" as const,
  };
}

export async function getReviewDecision(user: SessionUser, targetId: string) {
  if (process.env.DATABASE_URL)
    return production.getReviewDecision(user, targetId);
  return demo.getReviewDecision(targetId);
}

export async function listReviewRequests(user: SessionUser) {
  return adapter().listReviewRequests(user);
}

export async function getReviewRequest(user: SessionUser, targetId: string) {
  return adapter().getReviewRequest(user, targetId);
}

export async function getReviewArtifactHash(
  user: SessionUser,
  targetId: string,
) {
  return adapter().getReviewArtifactHash(user, targetId);
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
  if (process.env.DATABASE_URL)
    return production.setReviewDecision(user, targetId, input);
  return demo.setReviewDecision(user, targetId, input);
}

export async function appendAuditEvent(
  user: SessionUser,
  input: Parameters<typeof demo.appendAuditEvent>[1],
) {
  return adapter().appendAuditEvent(user, input);
}

export async function searchEvidence(
  input: Parameters<typeof production.searchEvidence>[0],
) {
  return production.searchEvidence(input);
}
