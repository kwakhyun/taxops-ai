ALTER TABLE "documents" ADD COLUMN "injection_scan_status" varchar(20) DEFAULT 'UNSCANNED' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "injection_scan_model" varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "injection_scan_threshold" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "injection_risk_score" numeric(5, 4);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "injection_scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_injection_scan_status_valid" CHECK ("documents"."injection_scan_status" IN ('UNSCANNED', 'SAFE', 'BLOCKED'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_injection_scan_score_valid" CHECK ("documents"."injection_risk_score" IS NULL OR ("documents"."injection_risk_score" >= 0 AND "documents"."injection_risk_score" <= 1));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_injection_scan_threshold_valid" CHECK ("documents"."injection_scan_threshold" IS NULL OR ("documents"."injection_scan_threshold" >= 0.1 AND "documents"."injection_scan_threshold" <= 0.99));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_injection_scan_complete" CHECK (("documents"."injection_scan_status" = 'UNSCANNED' AND "documents"."injection_scan_model" IS NULL AND "documents"."injection_scan_threshold" IS NULL AND "documents"."injection_risk_score" IS NULL AND "documents"."injection_scanned_at" IS NULL) OR ("documents"."injection_scan_status" IN ('SAFE', 'BLOCKED') AND "documents"."injection_scan_model" IS NOT NULL AND "documents"."injection_scan_threshold" IS NOT NULL AND "documents"."injection_risk_score" IS NOT NULL AND "documents"."injection_scanned_at" IS NOT NULL));
--> statement-breakpoint
WITH security_rescan AS (
  UPDATE documents
  SET status = 'QUARANTINED', evidence_status = 'PENDING',
      evidence_reviewed_by = NULL, evidence_reviewed_at = NULL,
      evidence_manifest_sha256 = NULL, indexed_at = NULL,
      version = version + 1, updated_at = now()
  WHERE status = 'INDEXED'
    AND object_version_id IS NOT NULL
    AND object_etag IS NOT NULL
    AND object_checksum_sha256 IS NOT NULL
  RETURNING id, tenant_id, version
)
INSERT INTO jobs (tenant_id, type, idempotency_key, payload)
SELECT tenant_id, 'DOCUMENT_INGESTION',
       'security-rescan:' || id::text || ':v' || version::text,
       jsonb_build_object(
         'documentId', id::text,
         'reason', 'PROMPT_INJECTION_CLASSIFIER_BACKFILL'
       )
FROM security_rescan
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
--> statement-breakpoint
WITH remediation AS (
  UPDATE documents
  SET status = 'FAILED', evidence_status = 'PENDING',
      evidence_reviewed_by = NULL, evidence_reviewed_at = NULL,
      evidence_manifest_sha256 = NULL, indexed_at = NULL,
      updated_at = now()
  WHERE status = 'INDEXED'
    AND (
      object_version_id IS NULL
      OR object_etag IS NULL
      OR object_checksum_sha256 IS NULL
    )
  RETURNING id, tenant_id
)
INSERT INTO outbox_events (
  tenant_id, topic, aggregate_type, aggregate_id, payload, idempotency_key
)
SELECT tenant_id, 'document.security_rescan_blocked', 'document', id,
       jsonb_build_object(
         'documentId', id::text,
         'reason', 'IMMUTABLE_OBJECT_BINDING_REQUIRED'
       ),
       'security-rescan-blocked:' || id::text
FROM remediation
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT UPDATE (
      injection_scan_status, injection_scan_model,
      injection_scan_threshold, injection_risk_score, injection_scanned_at
    ) ON documents TO taxops_worker;
  END IF;
END;
$permissions$;
