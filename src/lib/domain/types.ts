export const roles = ["ADMIN", "REVIEWER", "ANALYST"] as const;
export type Role = (typeof roles)[number];

export type Permission =
  | "case:read"
  | "case:write"
  | "document:read"
  | "document:upload"
  | "authority:ingest"
  | "assistant:run"
  | "workpaper:review"
  | "member:manage"
  | "audit:read";

export type MatterStatus = "IN_REVIEW" | "READY" | "NEEDS_INFO" | "CLOSED";
export type RiskLevel = "HIGH" | "MEDIUM" | "LOW";
export type DocumentStatus =
  "QUARANTINED" | "SCANNING" | "PARSING" | "INDEXED" | "FAILED";
export type EvidenceStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface SessionUser {
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  email: string;
  role: Role;
  initials: string;
}

export interface Matter {
  id: string;
  client: string;
  taxType: string;
  period: string;
  owner: string;
  reviewer: string;
  status: MatterStatus;
  risk: RiskLevel;
  progress: number;
  dueDate: string;
  /** null means that findings have not been assessed. */
  openFindings: number | null;
  /** Percentage of registered documents that are indexed and approved. */
  evidenceCoverage: number;
  updatedAt: string;
  summary: string;
}

export interface DocumentRecord {
  id: string;
  matterId: string;
  name: string;
  kind: string;
  size: string;
  status: DocumentStatus;
  evidenceStatus: EvidenceStatus;
  pages: number;
  chunks: number;
  piiClass: "RESTRICTED" | "CONFIDENTIAL" | "INTERNAL";
  uploadedBy: string;
  updatedAt: string;
  checksum: string;
  sourceType: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  evidenceReviewable?: boolean;
}

export interface EvidenceReviewPreview {
  documentId: string;
  matterId: string;
  name: string;
  version: number;
  uploadedBy: string;
  checksumSha256: string;
  manifestSha256: string;
  chunkCount: number;
  previewChunks: Array<{
    id: string;
    page: number | null;
    section: string | null;
    excerpt: string;
    contentHash: string;
    sourceType: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
    jurisdiction: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
  }>;
  sourcePublisher: string | null;
  sourceUri: string | null;
  acquiredAt: string | null;
}

export interface Evidence {
  id: string;
  tenantId: string;
  matterId: string;
  documentId: string;
  documentName: string;
  page: number | null;
  section: string;
  excerpt: string;
  contentHash: string;
  sourceType: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  jurisdiction: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourcePublisher: string | null;
  sourceUri: string | null;
  acquiredAt: string | null;
  effectiveDate: string;
  score: number;
}

export interface AgentRun {
  id: string;
  matterId: string;
  status: "COMPLETED" | "RUNNING" | "NEEDS_REVIEW" | "FAILED";
  question: string;
  startedAt: string;
  latencyMs: number;
  tokens: number;
  estimatedCostKrw: number;
  retrievalHits: number;
  evidenceCoverage: number;
  promptVersion: string;
  model: string;
  traceId: string;
}

export interface AuditEvent {
  id: string;
  tenantId?: string;
  actorId?: string;
  targetType?: string;
  metadata?: Record<string, string | number | boolean | null>;
  occurredAt: string;
  actor: string;
  action: string;
  target: string;
  outcome: "SUCCESS" | "DENIED" | "FAILED";
  traceId: string;
  ipMasked: string;
  prevHash: string;
  hash: string;
}

export interface WorkflowStep {
  key: "INTAKE" | "RETRIEVE" | "DRAFT" | "VERIFY" | "AWAITING_REVIEW";
  label: string;
  description: string;
  status: "COMPLETE" | "ACTIVE" | "WAITING" | "BLOCKED";
  latencyMs?: number;
}

export interface MatterAnalysis {
  latestRun: AgentRun;
  workflowSteps: WorkflowStep[];
  workpaper?: {
    title: string;
    conclusion: string;
    amountKrw?: number;
    reviewStatus: "PENDING" | "APPROVED" | "REJECTED";
    evidence: Array<{
      id: string;
      documentName: string;
      page: number | null;
      section: string | null;
      excerpt: string;
      contentHash: string;
    }>;
  };
}
