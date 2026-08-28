ALTER TABLE "approvals" ADD COLUMN "target_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "evidence_manifest_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "workpaper_versions" ADD COLUMN "artifact_hash" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tenant_matter_id_unique" ON "documents" USING btree ("tenant_id","matter_id","id");--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_document_matter_scope_fk" FOREIGN KEY ("tenant_id","matter_id","document_id") REFERENCES "public"."documents"("tenant_id","matter_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_evidence_manifest_valid" CHECK ("documents"."evidence_manifest_sha256" IS NULL OR "documents"."evidence_manifest_sha256" ~ '^[a-f0-9]{64}$');
--> statement-breakpoint
UPDATE workpaper_versions version
SET artifact_hash = approval.request_hash
FROM approvals approval, workpapers workpaper
WHERE approval.tenant_id = version.tenant_id
  AND approval.target_type = 'workpaper'
  AND approval.target_id = version.workpaper_id
  AND workpaper.tenant_id = version.tenant_id
  AND workpaper.id = version.workpaper_id
  AND version.version = workpaper.current_version
  AND approval.target_version = version.version
  AND version.artifact_hash IS NULL;
--> statement-breakpoint
CREATE FUNCTION enforce_worker_chunk_write() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'taxops_worker' AND NOT EXISTS (
    SELECT 1
    FROM documents document
    WHERE document.tenant_id = NEW.tenant_id
      AND document.id = NEW.document_id
      AND document.matter_id = NEW.matter_id
      AND document.version = NEW.document_version
      AND document.source_type = NEW.source_type
      AND document.status = 'PARSING'
      AND document.evidence_status = 'PENDING'
  ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'worker chunk writes require the current pending parsing document';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER worker_chunk_write_guard
BEFORE INSERT OR UPDATE ON document_chunks
FOR EACH ROW EXECUTE FUNCTION enforce_worker_chunk_write();
--> statement-breakpoint
CREATE FUNCTION append_application_audit_event(
  p_tenant uuid,
  p_actor uuid,
  p_action text,
  p_target_type text,
  p_target uuid,
  p_outcome text,
  p_trace_id text,
  p_metadata jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_allowed boolean := false;
  v_id uuid;
  v_expected_type text;
  v_expected_outcome text := 'SUCCESS';
  v_metadata jsonb := '{}'::jsonb;
BEGIN
  IF session_user <> 'taxops_app'
     OR nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant THEN
    RAISE insufficient_privilege USING MESSAGE = 'application audit writer is not allowed';
  END IF;

  IF p_action = 'AI_RUN_CREATED' THEN
    v_expected_type := 'agent_run';
    SELECT EXISTS (
      SELECT 1 FROM public.agent_runs run
      WHERE run.tenant_id = p_tenant AND run.id = p_target
        AND run.actor_id = p_actor AND run.trace_id = p_trace_id
        AND run.workflow_status = 'INTAKE' AND run.completed_at IS NULL
    ) INTO v_allowed;
  ELSIF p_action IN ('AI_RUN_COMPLETED', 'AI_RUN_FAILED', 'AI_RUN_STALE_RECOVERED') THEN
    v_expected_type := 'agent_run';
    IF p_action <> 'AI_RUN_COMPLETED' THEN
      v_expected_outcome := 'FAILED';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.agent_runs run
      WHERE run.tenant_id = p_tenant AND run.id = p_target
        AND run.actor_id = p_actor AND run.trace_id = p_trace_id
        AND run.completed_at IS NOT NULL
        AND (
          (p_action = 'AI_RUN_COMPLETED' AND run.workflow_status IN ('VERIFY', 'AWAITING_REVIEW'))
          OR (p_action = 'AI_RUN_FAILED' AND run.workflow_status = 'FAILED')
          OR (p_action = 'AI_RUN_STALE_RECOVERED' AND run.workflow_status = 'FAILED'
              AND run.error_code = 'STALE_STREAM_RECOVERED')
        )
    ) INTO v_allowed;
  ELSIF p_action = 'WORKPAPER_REVIEW_REQUESTED' THEN
    v_expected_type := 'workpaper';
    SELECT EXISTS (
      SELECT 1
      FROM public.workpapers workpaper
      JOIN public.workpaper_versions version
        ON version.tenant_id = workpaper.tenant_id
       AND version.workpaper_id = workpaper.id
       AND version.version = workpaper.current_version
      JOIN public.approvals approval
        ON approval.tenant_id = workpaper.tenant_id
       AND approval.target_id = workpaper.id
       AND approval.target_type = 'workpaper'
      WHERE workpaper.tenant_id = p_tenant AND workpaper.id = p_target
        AND workpaper.created_by = p_actor
        AND approval.requested_by = p_actor
        AND approval.status = 'PENDING'
        AND version.provenance->>'traceId' = p_trace_id
    ) INTO v_allowed;
  ELSIF p_action = 'MATTER_CREATED' THEN
    v_expected_type := 'matter';
    SELECT EXISTS (
      SELECT 1 FROM public.matters matter
      WHERE matter.tenant_id = p_tenant AND matter.id = p_target
        AND matter.owner_id = p_actor
    ) INTO v_allowed;
  ELSIF p_action = 'DOCUMENT_QUEUED' THEN
    v_expected_type := 'document';
    SELECT EXISTS (
      SELECT 1 FROM public.documents document
      WHERE document.tenant_id = p_tenant AND document.id = p_target
        AND document.uploaded_by = p_actor
        AND document.status = 'QUARANTINED'
        AND EXISTS (
          SELECT 1 FROM public.jobs job
          WHERE job.tenant_id = document.tenant_id
            AND job.payload->>'documentId' = document.id::text
        )
    ) INTO v_allowed;
  ELSIF p_action = 'DOCUMENT_UPLOAD_DEDUPLICATED' THEN
    v_expected_type := 'document';
    SELECT EXISTS (
      SELECT 1 FROM public.documents document
      WHERE document.tenant_id = p_tenant AND document.id = p_target
        AND document.uploaded_by = p_actor
        AND EXISTS (
          SELECT 1 FROM public.jobs job
          WHERE job.tenant_id = document.tenant_id
            AND job.payload->>'documentId' = document.id::text
        )
    ) INTO v_allowed;
  ELSIF p_action IN ('MCP_SEARCH_EVIDENCE', 'AI_DEMO_RUN_CREATED') THEN
    v_expected_type := 'matter';
    SELECT EXISTS (
      SELECT 1 FROM public.matters matter
      WHERE matter.tenant_id = p_tenant AND matter.id = p_target
    ) INTO v_allowed;
  ELSIF p_action = 'MCP_LIST_MATTERS' THEN
    v_expected_type := 'tenant';
    v_allowed := p_target = p_tenant;
  END IF;

  IF NOT v_allowed
     OR p_target_type IS DISTINCT FROM v_expected_type
     OR p_outcome IS DISTINCT FROM v_expected_outcome THEN
    RAISE insufficient_privilege USING MESSAGE = 'audit action is not bound to application state';
  END IF;

  IF p_action IN ('AI_RUN_CREATED', 'AI_RUN_COMPLETED', 'AI_RUN_FAILED', 'AI_RUN_STALE_RECOVERED') THEN
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'matterId', run.matter_id::text,
      'status', run.workflow_status::text,
      'latencyMs', run.latency_ms,
      'inputTokens', run.input_tokens,
      'outputTokens', run.output_tokens
    )) INTO v_metadata
    FROM public.agent_runs run
    WHERE run.tenant_id = p_tenant AND run.id = p_target;
  ELSIF p_action = 'WORKPAPER_REVIEW_REQUESTED' THEN
    SELECT jsonb_build_object(
      'runId', version.provenance->>'runId',
      'version', version.version
    ) INTO v_metadata
    FROM public.workpaper_versions version
    WHERE version.tenant_id = p_tenant
      AND version.workpaper_id = p_target
    ORDER BY version.version DESC LIMIT 1;
  ELSIF p_action IN ('DOCUMENT_QUEUED', 'DOCUMENT_UPLOAD_DEDUPLICATED') THEN
    SELECT jsonb_build_object('jobId', job.id::text) INTO v_metadata
    FROM public.jobs job
    WHERE job.tenant_id = p_tenant
      AND job.payload->>'documentId' = p_target::text
    ORDER BY job.created_at DESC LIMIT 1;
  END IF;
  SELECT public.append_audit_event_secure(
    p_tenant, p_actor, p_action, p_target_type, p_target, p_outcome,
    p_trace_id, COALESCE(v_metadata, '{}'::jsonb)
  ) INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION append_application_audit_event(uuid, uuid, text, text, uuid, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION decide_document_evidence(
  p_tenant uuid,
  p_document uuid,
  p_reviewer uuid,
  p_decision text,
  p_checksum text,
  p_version integer,
  p_manifest_hash text,
  p_trace_id text
) RETURNS TABLE(document_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_document_id uuid;
BEGIN
  IF session_user <> 'taxops_reviewer'
     OR nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant
     OR p_decision NOT IN ('APPROVED', 'REJECTED')
     OR p_checksum !~ '^[a-f0-9]{64}$'
     OR p_manifest_hash !~ '^[a-f0-9]{64}$'
     OR p_version < 1
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships membership
       WHERE membership.tenant_id = p_tenant
         AND membership.user_id = p_reviewer
         AND membership.role IN ('REVIEWER', 'ADMIN')
     ) THEN
    RETURN;
  END IF;
  UPDATE public.documents document
  SET evidence_status = p_decision,
      evidence_reviewed_by = p_reviewer,
      evidence_reviewed_at = now(),
      updated_at = now()
  FROM public.matters matter
  WHERE document.tenant_id = p_tenant
    AND document.id = p_document
    AND document.matter_id = matter.id
    AND document.tenant_id = matter.tenant_id
    AND matter.reviewer_id = p_reviewer
    AND document.uploaded_by <> p_reviewer
    AND document.checksum_sha256 = p_checksum
    AND document.evidence_manifest_sha256 = p_manifest_hash
    AND document.version = p_version
    AND document.status = 'INDEXED'
    AND document.evidence_status = 'PENDING'
  RETURNING document.id INTO v_document_id;
  IF v_document_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM public.append_audit_event_secure(
    p_tenant, p_reviewer,
    CASE p_decision WHEN 'APPROVED' THEN 'DOCUMENT_EVIDENCE_APPROVED'
                    ELSE 'DOCUMENT_EVIDENCE_REJECTED' END,
    'document', v_document_id, 'SUCCESS', p_trace_id,
    jsonb_build_object(
      'checksumSha256', p_checksum,
      'manifestSha256', p_manifest_hash,
      'version', p_version
    )
  );
  document_id := v_document_id;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION decide_workpaper_review(
  p_tenant uuid,
  p_target uuid,
  p_reviewer uuid,
  p_decision text,
  p_note text,
  p_artifact_hash text,
  p_trace_id text
) RETURNS TABLE(decision text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_decision text;
BEGIN
  IF session_user <> 'taxops_reviewer'
     OR nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant
     OR p_decision NOT IN ('APPROVED', 'REJECTED')
     OR p_note IS NULL
     OR char_length(p_note) NOT BETWEEN 4 AND 2000
     OR p_artifact_hash !~ '^[a-f0-9]{64}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships membership
       WHERE membership.tenant_id = p_tenant
         AND membership.user_id = p_reviewer
         AND membership.role IN ('REVIEWER', 'ADMIN')
     ) THEN
    RETURN;
  END IF;
  UPDATE public.approvals approval
  SET status = p_decision::public.approval_status,
      decision_note = p_note,
      decided_at = now(),
      updated_at = now()
  WHERE approval.tenant_id = p_tenant
    AND approval.target_id = p_target
    AND approval.reviewer_id = p_reviewer
    AND approval.requested_by <> p_reviewer
    AND approval.target_type = 'workpaper'
    AND approval.request_hash = p_artifact_hash
    AND approval.expires_at > now()
    AND approval.status = 'PENDING'
    AND EXISTS (
      SELECT 1
      FROM public.workpapers workpaper
      JOIN public.workpaper_versions version
        ON version.tenant_id = workpaper.tenant_id
       AND version.workpaper_id = workpaper.id
       AND version.version = workpaper.current_version
      JOIN public.matters matter
        ON matter.tenant_id = workpaper.tenant_id
       AND matter.id = workpaper.matter_id
      JOIN public.agent_runs run
        ON run.tenant_id = workpaper.tenant_id
       AND run.id::text = version.provenance->>'runId'
      WHERE workpaper.tenant_id = approval.tenant_id
        AND workpaper.id = approval.target_id
        AND matter.reviewer_id = p_reviewer
        AND approval.target_version = workpaper.current_version
        AND version.artifact_hash = p_artifact_hash
        AND run.workflow_status = 'AWAITING_REVIEW'
        AND run.completed_at IS NOT NULL
        AND run.error_code IS NULL
    )
  RETURNING approval.status::text INTO v_decision;
  IF v_decision IS NULL THEN
    RETURN;
  END IF;
  PERFORM public.append_audit_event_secure(
    p_tenant, p_reviewer,
    CASE p_decision WHEN 'APPROVED' THEN 'WORKPAPER_APPROVED'
                    ELSE 'WORKPAPER_REJECTED' END,
    'workpaper', p_target, 'SUCCESS', p_trace_id,
    jsonb_build_object('artifactHash', p_artifact_hash)
  );
  decision := v_decision;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    REVOKE ALL ON FUNCTION append_audit_event_secure(uuid, uuid, text, text, uuid, text, text, jsonb) FROM taxops_app;
    GRANT EXECUTE ON FUNCTION append_application_audit_event(uuid, uuid, text, text, uuid, text, text, jsonb) TO taxops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_reviewer') THEN
    REVOKE ALL ON FUNCTION append_audit_event_secure(uuid, uuid, text, text, uuid, text, text, jsonb) FROM taxops_reviewer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT UPDATE (evidence_manifest_sha256) ON documents TO taxops_worker;
  END IF;
END;
$permissions$;
