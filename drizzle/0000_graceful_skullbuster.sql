CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('SUCCESS', 'DENIED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('QUARANTINED', 'SCANNING', 'PARSING', 'INDEXED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."matter_status" AS ENUM('IN_REVIEW', 'READY', 'NEEDS_INFO', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('ADMIN', 'REVIEWER', 'ANALYST');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('INTAKE', 'RETRIEVE', 'DRAFT', 'VERIFY', 'AWAITING_REVIEW', 'APPROVED', 'REJECTED', 'FAILED');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"workflow_status" "workflow_status" DEFAULT 'INTAKE' NOT NULL,
	"trace_id" varchar(80) NOT NULL,
	"model_id" varchar(120) NOT NULL,
	"prompt_version" varchar(40) NOT NULL,
	"retriever_version" varchar(40) NOT NULL,
	"policy_version" varchar(40) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_krw" numeric(12, 4) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"evidence_coverage" numeric(5, 2),
	"error_code" varchar(80),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"target_type" varchar(60) NOT NULL,
	"target_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"action" varchar(120) NOT NULL,
	"target_type" varchar(80) NOT NULL,
	"target_id" text NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"trace_id" varchar(80) NOT NULL,
	"metadata" jsonb NOT NULL,
	"previous_hash" varchar(64) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"registration_number_encrypted" text,
	"industry" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"page_number" integer,
	"section" text,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"jurisdiction" varchar(16) DEFAULT 'KR' NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"is_current" boolean DEFAULT true NOT NULL,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_char_span_valid" CHECK ("document_chunks"."char_start" >= 0 AND "document_chunks"."char_end" > "document_chunks"."char_start")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"mime_type" varchar(140) NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"status" "document_status" DEFAULT 'QUARANTINED' NOT NULL,
	"evidence_status" varchar(20) DEFAULT 'PENDING' NOT NULL,
	"evidence_reviewed_by" uuid,
	"evidence_reviewed_at" timestamp with time zone,
	"pii_classification" varchar(30) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_size_positive" CHECK ("documents"."byte_size" > 0),
	CONSTRAINT "documents_evidence_status_valid" CHECK ("documents"."evidence_status" IN ('PENDING', 'APPROVED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" varchar(80) NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(80),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_progress_range" CHECK ("jobs"."progress" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "matters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"slug" varchar(100) NOT NULL,
	"tax_type" varchar(80) NOT NULL,
	"tax_period" varchar(80) NOT NULL,
	"summary" text NOT NULL,
	"status" "matter_status" DEFAULT 'IN_REVIEW' NOT NULL,
	"risk" "risk_level" DEFAULT 'LOW' NOT NULL,
	"owner_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"topic" varchar(120) NOT NULL,
	"aggregate_type" varchar(80) NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"tenant_id" uuid NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_buckets_tenant_id_key_hash_pk" PRIMARY KEY("tenant_id","key_hash"),
	CONSTRAINT "rate_limit_count_positive" CHECK ("rate_limit_buckets"."count" > 0)
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"version" varchar(40) NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"content" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retrieval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"query_hash" varchar(64) NOT NULL,
	"chunk_ids" uuid[] NOT NULL,
	"scores" jsonb NOT NULL,
	"filter_summary" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(80) NOT NULL,
	"data_region" varchar(30) DEFAULT 'ap-northeast-2' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"pii_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tool_name" varchar(100) NOT NULL,
	"tool_version" varchar(40) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"output_hash" varchar(64),
	"status" varchar(30) NOT NULL,
	"approval_id" uuid,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"oidc_subject" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_oidc_subject_unique" UNIQUE("oidc_subject")
);
--> statement-breakpoint
CREATE TABLE "workpaper_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workpaper_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workpapers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matter_id" uuid NOT NULL,
	"title" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_trace_unique" ON "agent_runs" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_tenant_id_unique" ON "agent_runs" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_matter_idx" ON "agent_runs" USING btree ("tenant_id","matter_id","started_at");--> statement-breakpoint
CREATE INDEX "approvals_reviewer_status_idx" ON "approvals" USING btree ("tenant_id","reviewer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_hash_unique" ON "audit_events" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "audit_tenant_time_idx" ON "audit_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_trace_idx" ON "audit_events" USING btree ("trace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_name_unique" ON "clients" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_id_unique" ON "clients" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_document_position_unique" ON "document_chunks" USING btree ("tenant_id","document_id","document_version","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_scope_idx" ON "document_chunks" USING btree ("tenant_id","matter_id","is_current");--> statement-breakpoint
CREATE INDEX "chunks_fts_idx" ON "document_chunks" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_checksum_unique" ON "documents" USING btree ("tenant_id","matter_id","checksum_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_id_unique" ON "documents" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "documents_matter_status_idx" ON "documents" USING btree ("tenant_id","matter_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_tenant_idempotency_unique" ON "jobs" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matters_tenant_slug_unique" ON "matters" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "matters_tenant_id_unique" ON "matters" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "matters_tenant_status_due_idx" ON "matters" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_tenant_idempotency_unique" ON "outbox_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("published_at","available_at");--> statement-breakpoint
CREATE INDEX "rate_limit_window_idx" ON "rate_limit_buckets" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_name_version_unique" ON "prompt_versions" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "retrieval_run_idx" ON "retrieval_events" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workpaper_versions_unique" ON "workpaper_versions" USING btree ("tenant_id","workpaper_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workpapers_tenant_id_unique" ON "workpapers" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "workpapers_matter_idx" ON "workpapers" USING btree ("tenant_id","matter_id");
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_client_scope_fk" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "clients"("tenant_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_owner_scope_fk" FOREIGN KEY ("tenant_id", "owner_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_reviewer_scope_fk" FOREIGN KEY ("tenant_id", "reviewer_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_matter_scope_fk" FOREIGN KEY ("tenant_id", "matter_id") REFERENCES "matters"("tenant_id", "id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploader_scope_fk" FOREIGN KEY ("tenant_id", "uploaded_by") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_evidence_reviewer_scope_fk" FOREIGN KEY ("tenant_id", "evidence_reviewed_by") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_document_scope_fk" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "documents"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_matter_scope_fk" FOREIGN KEY ("tenant_id", "matter_id") REFERENCES "matters"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_matter_scope_fk" FOREIGN KEY ("tenant_id", "matter_id") REFERENCES "matters"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_actor_scope_fk" FOREIGN KEY ("tenant_id", "actor_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "retrieval_events" ADD CONSTRAINT "retrieval_run_scope_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "agent_runs"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_run_scope_fk" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "agent_runs"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "workpapers" ADD CONSTRAINT "workpapers_matter_scope_fk" FOREIGN KEY ("tenant_id", "matter_id") REFERENCES "matters"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "workpapers" ADD CONSTRAINT "workpapers_creator_scope_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "workpaper_versions" ADD CONSTRAINT "workpaper_versions_workpaper_scope_fk" FOREIGN KEY ("tenant_id", "workpaper_id") REFERENCES "workpapers"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "workpaper_versions" ADD CONSTRAINT "workpaper_versions_creator_scope_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requester_scope_fk" FOREIGN KEY ("tenant_id", "requested_by") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_reviewer_scope_fk" FOREIGN KEY ("tenant_id", "reviewer_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE restrict;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE restrict;--> statement-breakpoint

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "retrieval_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workpapers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workpaper_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation_tenants ON "tenants" USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_users ON "users" USING (EXISTS (SELECT 1 FROM memberships membership WHERE membership.user_id = users.id AND membership.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY tenant_isolation_memberships ON "memberships" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_clients ON "clients" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_matters ON "matters" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_documents ON "documents" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_document_chunks ON "document_chunks" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_jobs ON "jobs" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_outbox ON "outbox_events" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_rate_limits ON "rate_limit_buckets" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_agent_runs ON "agent_runs" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_retrieval_events ON "retrieval_events" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_tool_calls ON "tool_calls" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_workpapers ON "workpapers" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_workpaper_versions ON "workpaper_versions" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_approvals ON "approvals" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_isolation_audit_events ON "audit_events" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE FUNCTION claim_next_job(p_worker_id text)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  type varchar,
  payload jsonb,
  attempts integer,
  max_attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT queued.id
    FROM jobs queued
    WHERE (
      (queued.status IN ('QUEUED', 'RETRYING') AND queued.available_at <= now())
      OR (
        queued.status = 'RUNNING'
        AND (queued.lease_expires_at IS NULL OR queued.lease_expires_at < now())
      )
    )
    ORDER BY queued.available_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE jobs queued
    SET status = 'RUNNING',
        attempts = queued.attempts + 1,
        lease_owner = p_worker_id,
        lease_expires_at = now() + interval '90 seconds',
        updated_at = now()
    FROM candidate
    WHERE queued.id = candidate.id
    RETURNING queued.id, queued.tenant_id, queued.type, queued.payload,
              queued.attempts, queued.max_attempts
  )
  SELECT claimed.id, claimed.tenant_id, claimed.type, claimed.payload,
         claimed.attempts, claimed.max_attempts
  FROM claimed;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_next_job(text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION claim_next_outbox()
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  topic varchar,
  aggregate_type varchar,
  aggregate_id uuid,
  payload jsonb,
  idempotency_key varchar,
  attempts integer
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT pending.id
    FROM outbox_events pending
    WHERE pending.published_at IS NULL
      AND pending.available_at <= now()
      AND pending.attempts < 10
    ORDER BY pending.available_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE outbox_events pending
    SET attempts = pending.attempts + 1,
        available_at = now() + make_interval(
          secs => least(3600, (power(2, pending.attempts)::integer * 5))
        ),
        last_error_code = NULL
    FROM candidate
    WHERE pending.id = candidate.id
    RETURNING pending.id, pending.tenant_id, pending.topic,
              pending.aggregate_type, pending.aggregate_id, pending.payload,
              pending.idempotency_key, pending.attempts
  )
  SELECT claimed.id, claimed.tenant_id, claimed.topic,
         claimed.aggregate_type, claimed.aggregate_id, claimed.payload,
         claimed.idempotency_key, claimed.attempts
  FROM claimed;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_next_outbox() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION prevent_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
--> statement-breakpoint
CREATE FUNCTION prevent_workpaper_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workpaper_versions are append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER workpaper_versions_immutable BEFORE UPDATE OR DELETE ON "workpaper_versions" FOR EACH ROW EXECUTE FUNCTION prevent_workpaper_version_mutation();
--> statement-breakpoint
CREATE FUNCTION protect_document_chunk_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.matter_id IS DISTINCT FROM OLD.matter_id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.document_version IS DISTINCT FROM OLD.document_version
     OR NEW.chunk_index IS DISTINCT FROM OLD.chunk_index
     OR NEW.page_number IS DISTINCT FROM OLD.page_number
     OR NEW.section IS DISTINCT FROM OLD.section
     OR NEW.char_start IS DISTINCT FROM OLD.char_start
     OR NEW.char_end IS DISTINCT FROM OLD.char_end
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'document chunk source content is immutable; insert a new version';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER document_chunks_content_immutable BEFORE UPDATE ON "document_chunks" FOR EACH ROW EXECUTE FUNCTION protect_document_chunk_content();
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    GRANT USAGE ON SCHEMA public TO taxops_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO taxops_app;
    REVOKE UPDATE, DELETE ON workpaper_versions, audit_events FROM taxops_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taxops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT USAGE ON SCHEMA public TO taxops_worker;
    GRANT SELECT, UPDATE ON jobs TO taxops_worker;
    GRANT SELECT ON documents TO taxops_worker;
    GRANT UPDATE (status, indexed_at, updated_at) ON documents TO taxops_worker;
    GRANT SELECT ON tenants TO taxops_worker;
    GRANT SELECT, INSERT ON document_chunks TO taxops_worker;
    GRANT UPDATE (is_current, embedding) ON document_chunks TO taxops_worker;
    GRANT SELECT, INSERT, UPDATE ON outbox_events TO taxops_worker;
    GRANT EXECUTE ON FUNCTION claim_next_job(text) TO taxops_worker;
    GRANT EXECUTE ON FUNCTION claim_next_outbox() TO taxops_worker;
  END IF;
END;
$permissions$;
