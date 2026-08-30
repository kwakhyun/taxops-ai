import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("membership_role", [
  "ADMIN",
  "REVIEWER",
  "ANALYST",
]);
export const matterStatusEnum = pgEnum("matter_status", [
  "IN_REVIEW",
  "READY",
  "NEEDS_INFO",
  "CLOSED",
]);
export const riskEnum = pgEnum("risk_level", ["HIGH", "MEDIUM", "LOW"]);
export const documentStatusEnum = pgEnum("document_status", [
  "QUARANTINED",
  "SCANNING",
  "PARSING",
  "INDEXED",
  "FAILED",
]);
export const jobStatusEnum = pgEnum("job_status", [
  "QUEUED",
  "RUNNING",
  "RETRYING",
  "SUCCEEDED",
  "FAILED",
  "DEAD",
  "CANCELLED",
]);
export const workflowStatusEnum = pgEnum("workflow_status", [
  "INTAKE",
  "RETRIEVE",
  "DRAFT",
  "VERIFY",
  "AWAITING_REVIEW",
  "APPROVED",
  "REJECTED",
  "FAILED",
]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "PENDING",
  "APPROVED",
  "REJECTED",
]);
export const auditOutcomeEnum = pgEnum("audit_outcome", [
  "SUCCESS",
  "DENIED",
  "FAILED",
]);

const tenantColumns = {
  tenantId: uuid("tenant_id").notNull(),
};

const timestampColumns = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  dataRegion: varchar("data_region", { length: 30 })
    .default("ap-northeast-2")
    .notNull(),
  aiEnabled: boolean("ai_enabled").default(true).notNull(),
  piiPolicy: jsonb("pii_policy")
    .$type<Record<string, unknown>>()
    .default({})
    .notNull(),
  ...timestampColumns,
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  oidcSubject: text("oidc_subject").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  ...timestampColumns,
});

export const memberships = pgTable(
  "memberships",
  {
    ...tenantColumns,
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    ...timestampColumns,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.userId] }),
    index("memberships_user_idx").on(table.userId),
  ],
);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    name: text("name").notNull(),
    registrationNumberEncrypted: text("registration_number_encrypted"),
    industry: text("industry"),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("clients_tenant_name_unique").on(table.tenantId, table.name),
    uniqueIndex("clients_tenant_id_unique").on(table.tenantId, table.id),
  ],
);

export const matters = pgTable(
  "matters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    clientId: uuid("client_id").notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    taxType: varchar("tax_type", { length: 80 }).notNull(),
    taxPeriod: varchar("tax_period", { length: 80 }).notNull(),
    summary: text("summary").notNull(),
    status: matterStatusEnum("status").default("IN_REVIEW").notNull(),
    risk: riskEnum("risk").default("LOW").notNull(),
    ownerId: uuid("owner_id").notNull(),
    reviewerId: uuid("reviewer_id").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    version: integer("version").default(1).notNull(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("matters_tenant_slug_unique").on(table.tenantId, table.slug),
    uniqueIndex("matters_tenant_id_unique").on(table.tenantId, table.id),
    index("matters_tenant_status_due_idx").on(
      table.tenantId,
      table.status,
      table.dueAt,
    ),
    check(
      "matters_maker_checker_separation",
      sql`${table.ownerId} <> ${table.reviewerId}`,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    matterId: uuid("matter_id").notNull(),
    objectKey: text("object_key").notNull(),
    objectVersionId: text("object_version_id"),
    objectEtag: varchar("object_etag", { length: 200 }),
    objectChecksumSha256: varchar("object_checksum_sha256", { length: 64 }),
    originalName: text("original_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    mimeType: varchar("mime_type", { length: 140 }).notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksumSha256: varchar("checksum_sha256", { length: 64 }).notNull(),
    status: documentStatusEnum("status").default("QUARANTINED").notNull(),
    injectionScanStatus: varchar("injection_scan_status", { length: 20 })
      .default("UNSCANNED")
      .notNull(),
    injectionScanModel: varchar("injection_scan_model", { length: 255 }),
    injectionScanThreshold: numeric("injection_scan_threshold", {
      precision: 5,
      scale: 4,
    }),
    injectionRiskScore: numeric("injection_risk_score", {
      precision: 5,
      scale: 4,
    }),
    injectionScannedAt: timestamp("injection_scanned_at", {
      withTimezone: true,
    }),
    evidenceStatus: varchar("evidence_status", { length: 20 })
      .default("PENDING")
      .notNull(),
    evidenceReviewedBy: uuid("evidence_reviewed_by"),
    evidenceReviewedAt: timestamp("evidence_reviewed_at", {
      withTimezone: true,
    }),
    evidenceManifestSha256: varchar("evidence_manifest_sha256", { length: 64 }),
    piiClassification: varchar("pii_classification", { length: 30 }).notNull(),
    sourceType: varchar("source_type", { length: 30 })
      .default("BUSINESS_RECORD")
      .notNull(),
    sourcePublisher: text("source_publisher"),
    sourceUri: text("source_uri"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    version: integer("version").default(1).notNull(),
    uploadedBy: uuid("uploaded_by").notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("documents_tenant_checksum_unique").on(
      table.tenantId,
      table.matterId,
      table.checksumSha256,
    ),
    uniqueIndex("documents_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("documents_tenant_matter_id_unique").on(
      table.tenantId,
      table.matterId,
      table.id,
    ),
    index("documents_matter_status_idx").on(
      table.tenantId,
      table.matterId,
      table.status,
    ),
    check("documents_size_positive", sql`${table.byteSize} > 0`),
    check(
      "documents_evidence_status_valid",
      sql`${table.evidenceStatus} IN ('PENDING', 'APPROVED', 'REJECTED')`,
    ),
    check(
      "documents_source_type_valid",
      sql`${table.sourceType} IN ('BUSINESS_RECORD', 'TAX_AUTHORITY', 'INTERNAL_POLICY')`,
    ),
    check(
      "documents_authority_provenance_required",
      sql`${table.sourceType} <> 'TAX_AUTHORITY' OR (${table.sourcePublisher} IS NOT NULL AND ${table.sourceUri} ~ '^https://' AND ${table.acquiredAt} IS NOT NULL)`,
    ),
    check(
      "documents_evidence_manifest_valid",
      sql`${table.evidenceManifestSha256} IS NULL OR ${table.evidenceManifestSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "documents_object_checksum_valid",
      sql`${table.objectChecksumSha256} IS NULL OR ${table.objectChecksumSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "documents_object_binding_complete",
      sql`(${table.objectVersionId} IS NULL AND ${table.objectEtag} IS NULL AND ${table.objectChecksumSha256} IS NULL) OR (${table.objectVersionId} IS NOT NULL AND ${table.objectEtag} IS NOT NULL AND ${table.objectChecksumSha256} IS NOT NULL)`,
    ),
    check(
      "documents_injection_scan_status_valid",
      sql`${table.injectionScanStatus} IN ('UNSCANNED', 'SAFE', 'BLOCKED')`,
    ),
    check(
      "documents_injection_scan_score_valid",
      sql`${table.injectionRiskScore} IS NULL OR (${table.injectionRiskScore} >= 0 AND ${table.injectionRiskScore} <= 1)`,
    ),
    check(
      "documents_injection_scan_threshold_valid",
      sql`${table.injectionScanThreshold} IS NULL OR (${table.injectionScanThreshold} >= 0.1 AND ${table.injectionScanThreshold} <= 0.99)`,
    ),
    check(
      "documents_injection_scan_complete",
      sql`(${table.injectionScanStatus} = 'UNSCANNED' AND ${table.injectionScanModel} IS NULL AND ${table.injectionScanThreshold} IS NULL AND ${table.injectionRiskScore} IS NULL AND ${table.injectionScannedAt} IS NULL) OR (${table.injectionScanStatus} IN ('SAFE', 'BLOCKED') AND ${table.injectionScanModel} IS NOT NULL AND ${table.injectionScanThreshold} IS NOT NULL AND ${table.injectionRiskScore} IS NOT NULL AND ${table.injectionScannedAt} IS NOT NULL)`,
    ),
  ],
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    matterId: uuid("matter_id").notNull(),
    documentId: uuid("document_id").notNull(),
    documentVersion: integer("document_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    pageNumber: integer("page_number"),
    section: text("section"),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    content: text("content").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    sourceType: varchar("source_type", { length: 30 })
      .default("BUSINESS_RECORD")
      .notNull(),
    jurisdiction: varchar("jurisdiction", { length: 16 })
      .default("KR")
      .notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    isCurrent: boolean("is_current").default(true).notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("chunks_document_position_unique").on(
      table.tenantId,
      table.documentId,
      table.documentVersion,
      table.chunkIndex,
    ),
    foreignKey({
      name: "chunks_document_matter_scope_fk",
      columns: [table.tenantId, table.matterId, table.documentId],
      foreignColumns: [documents.tenantId, documents.matterId, documents.id],
    }).onDelete("cascade"),
    index("chunks_scope_idx").on(
      table.tenantId,
      table.matterId,
      table.isCurrent,
    ),
    index("chunks_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    index("chunks_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    check(
      "chunks_char_span_valid",
      sql`${table.charStart} >= 0 AND ${table.charEnd} > ${table.charStart}`,
    ),
    check(
      "chunks_page_number_positive",
      sql`${table.pageNumber} IS NULL OR ${table.pageNumber} > 0`,
    ),
    check(
      "chunks_content_hash_matches",
      sql`${table.contentHash} = encode(digest(convert_to(${table.content}, 'UTF8'), 'sha256'), 'hex')`,
    ),
    check(
      "chunks_source_type_valid",
      sql`${table.sourceType} IN ('BUSINESS_RECORD', 'TAX_AUTHORITY', 'INTERNAL_POLICY')`,
    ),
    check(
      "chunks_authority_effective_from_required",
      sql`${table.sourceType} = 'BUSINESS_RECORD' OR ${table.effectiveFrom} IS NOT NULL`,
    ),
    check(
      "chunks_effective_range_valid",
      sql`${table.effectiveTo} IS NULL OR ${table.effectiveFrom} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    type: varchar("type", { length: 80 }).notNull(),
    status: jobStatusEnum("status").default("QUEUED").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    progress: integer("progress").default(0).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("jobs_tenant_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("jobs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check("jobs_progress_range", sql`${table.progress} BETWEEN 0 AND 100`),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    topic: varchar("topic", { length: 120 }).notNull(),
    aggregateType: varchar("aggregate_type", { length: 80 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("outbox_tenant_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("outbox_unpublished_idx").on(table.publishedAt, table.availableAt),
  ],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    ...tenantColumns,
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    count: integer("count").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.keyHash] }),
    index("rate_limit_window_idx").on(table.updatedAt),
    check("rate_limit_count_positive", sql`${table.count} > 0`),
  ],
);

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    version: varchar("version", { length: 40 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    content: text("content").notNull(),
    isActive: boolean("is_active").default(false).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("prompt_name_version_unique").on(table.name, table.version),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    matterId: uuid("matter_id").notNull(),
    actorId: uuid("actor_id").notNull(),
    workflowStatus: workflowStatusEnum("workflow_status")
      .default("INTAKE")
      .notNull(),
    traceId: varchar("trace_id", { length: 80 }).notNull(),
    modelId: varchar("model_id", { length: 120 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 40 }).notNull(),
    promptHash: varchar("prompt_hash", { length: 64 }),
    retrieverVersion: varchar("retriever_version", { length: 40 }).notNull(),
    policyVersion: varchar("policy_version", { length: 40 }).notNull(),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    estimatedCostKrw: numeric("estimated_cost_krw", { precision: 12, scale: 4 })
      .default("0")
      .notNull(),
    latencyMs: integer("latency_ms"),
    evidenceCoverage: numeric("evidence_coverage", { precision: 5, scale: 2 }),
    errorCode: varchar("error_code", { length: 80 }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("agent_runs_trace_unique").on(table.traceId),
    uniqueIndex("agent_runs_tenant_id_unique").on(table.tenantId, table.id),
    index("agent_runs_tenant_matter_idx").on(
      table.tenantId,
      table.matterId,
      table.startedAt,
    ),
    check(
      "agent_runs_prompt_hash_valid",
      sql`${table.promptHash} IS NULL OR ${table.promptHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

export const retrievalEvents = pgTable(
  "retrieval_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    runId: uuid("run_id").notNull(),
    queryHash: varchar("query_hash", { length: 64 }).notNull(),
    chunkIds: uuid("chunk_ids").array().notNull(),
    scores: jsonb("scores").$type<number[]>().notNull(),
    filterSummary: jsonb("filter_summary")
      .$type<Record<string, string>>()
      .notNull(),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("retrieval_run_idx").on(table.tenantId, table.runId)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    runId: uuid("run_id").notNull(),
    toolName: varchar("tool_name", { length: 100 }).notNull(),
    toolVersion: varchar("tool_version", { length: 40 }).notNull(),
    inputHash: varchar("input_hash", { length: 64 }).notNull(),
    outputHash: varchar("output_hash", { length: 64 }),
    status: varchar("status", { length: 30 }).notNull(),
    approvalId: uuid("approval_id"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("tool_calls_run_idx").on(table.tenantId, table.runId)],
);

export const workpapers = pgTable(
  "workpapers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    matterId: uuid("matter_id").notNull(),
    title: text("title").notNull(),
    currentVersion: integer("current_version").default(1).notNull(),
    createdBy: uuid("created_by").notNull(),
    ...timestampColumns,
  },
  (table) => [
    uniqueIndex("workpapers_tenant_id_unique").on(table.tenantId, table.id),
    index("workpapers_matter_idx").on(table.tenantId, table.matterId),
  ],
);

export const workpaperVersions = pgTable(
  "workpaper_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    workpaperId: uuid("workpaper_id").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").$type<Record<string, unknown>>().notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull(),
    artifactHash: varchar("artifact_hash", { length: 64 }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("workpaper_versions_unique").on(
      table.tenantId,
      table.workpaperId,
      table.version,
    ),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    targetType: varchar("target_type", { length: 60 }).notNull(),
    targetId: uuid("target_id").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    reviewerId: uuid("reviewer_id").notNull(),
    status: approvalStatusEnum("status").default("PENDING").notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    targetVersion: integer("target_version").default(1).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    ...timestampColumns,
  },
  (table) => [
    index("approvals_reviewer_status_idx").on(
      table.tenantId,
      table.reviewerId,
      table.status,
    ),
    check(
      "approvals_maker_checker_separation",
      sql`${table.requestedBy} <> ${table.reviewerId}`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ...tenantColumns,
    actorId: text("actor_id").notNull(),
    action: varchar("action", { length: 120 }).notNull(),
    targetType: varchar("target_type", { length: 80 }).notNull(),
    targetId: text("target_id").notNull(),
    outcome: auditOutcomeEnum("outcome").notNull(),
    traceId: varchar("trace_id", { length: 80 }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
    previousHash: varchar("previous_hash", { length: 64 }).notNull(),
    hash: varchar("hash", { length: 64 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("audit_hash_unique").on(table.hash),
    index("audit_tenant_time_idx").on(table.tenantId, table.occurredAt),
    index("audit_trace_idx").on(table.traceId),
  ],
);
