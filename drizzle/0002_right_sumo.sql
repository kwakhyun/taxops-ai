ALTER TABLE "document_chunks" ADD COLUMN "source_type" varchar(30) DEFAULT 'BUSINESS_RECORD' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_type" varchar(30) DEFAULT 'BUSINESS_RECORD' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_publisher" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_uri" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "acquired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_maker_checker_separation" CHECK ("approvals"."requested_by" <> "approvals"."reviewer_id");--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_source_type_valid" CHECK ("document_chunks"."source_type" IN ('BUSINESS_RECORD', 'TAX_AUTHORITY', 'INTERNAL_POLICY'));--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_authority_effective_from_required" CHECK ("document_chunks"."source_type" = 'BUSINESS_RECORD' OR "document_chunks"."effective_from" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_effective_range_valid" CHECK ("document_chunks"."effective_to" IS NULL OR "document_chunks"."effective_from" IS NULL OR "document_chunks"."effective_to" > "document_chunks"."effective_from");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_type_valid" CHECK ("documents"."source_type" IN ('BUSINESS_RECORD', 'TAX_AUTHORITY', 'INTERNAL_POLICY'));--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_authority_provenance_required" CHECK ("documents"."source_type" <> 'TAX_AUTHORITY' OR ("documents"."source_publisher" IS NOT NULL AND "documents"."source_uri" ~ '^https://' AND "documents"."acquired_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "matters" ADD CONSTRAINT "matters_maker_checker_separation" CHECK ("matters"."owner_id" <> "matters"."reviewer_id");
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_document_chunk_content() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR NEW.source_type IS DISTINCT FROM OLD.source_type
     OR NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'document chunk source content is immutable; insert a new version';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION enforce_app_document_ingress() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'taxops_app' THEN
    NEW.status := 'QUARANTINED';
    NEW.evidence_status := 'PENDING';
    NEW.evidence_reviewed_by := NULL;
    NEW.evidence_reviewed_at := NULL;
    IF NEW.source_type = 'TAX_AUTHORITY' AND NOT EXISTS (
      SELECT 1 FROM memberships membership
      WHERE membership.tenant_id = NEW.tenant_id
        AND membership.user_id = NEW.uploaded_by
        AND membership.role = 'ADMIN'
    ) THEN
      RAISE insufficient_privilege USING MESSAGE = 'TAX_AUTHORITY ingestion requires an ADMIN membership';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_ingress_guard BEFORE INSERT ON documents
FOR EACH ROW EXECUTE FUNCTION enforce_app_document_ingress();
--> statement-breakpoint
CREATE FUNCTION enforce_pending_approval_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'taxops_app' THEN
    NEW.status := 'PENDING';
    NEW.decision_note := NULL;
    NEW.decided_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_insert_guard BEFORE INSERT ON approvals
FOR EACH ROW EXECUTE FUNCTION enforce_pending_approval_insert();
--> statement-breakpoint
CREATE FUNCTION canonical_audit_metadata(p_metadata jsonb) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    '{' || string_agg(
      to_jsonb(entry.key)::text || ':' || entry.value::text,
      ',' ORDER BY entry.key COLLATE "C"
    ) || '}',
    '{}'
  )
  FROM jsonb_each(COALESCE(p_metadata, '{}'::jsonb)) AS entry;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION canonical_audit_metadata(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION append_audit_event_secure(
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
  v_id uuid;
  v_previous_hash text := repeat('0', 64);
  v_previous_occurred timestamptz;
  v_occurred timestamptz;
  v_occurred_iso text;
  v_canonical_metadata text;
  v_hash text;
BEGIN
  IF session_user NOT IN ('taxops_app', 'taxops_reviewer') THEN
    RAISE insufficient_privilege USING MESSAGE = 'audit writer role is not allowed';
  END IF;
  IF p_tenant IS NULL
     OR p_actor IS NULL
     OR p_target IS NULL
     OR nullif(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant
     OR p_action IS NULL
     OR p_action !~ '^[A-Z][A-Z0-9_.:-]{0,119}$'
     OR p_target_type IS NULL
     OR p_target_type !~ '^[a-z][a-z0-9_-]{0,79}$'
     OR p_outcome NOT IN ('SUCCESS', 'DENIED', 'FAILED')
     OR p_trace_id IS NULL
     OR p_trace_id !~ '^[A-Za-z0-9_.:-]{1,80}$'
     OR jsonb_typeof(COALESCE(p_metadata, '{}'::jsonb)) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_each(COALESCE(p_metadata, '{}'::jsonb)) AS item
       WHERE jsonb_typeof(item.value) NOT IN ('string', 'number', 'boolean', 'null')
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships membership
       WHERE membership.tenant_id = p_tenant
         AND membership.user_id = p_actor
     ) THEN
    RAISE insufficient_privilege USING MESSAGE = 'audit event identity or payload is not allowed';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || p_tenant::text, 0));
  SELECT event.hash, event.occurred_at
  INTO v_previous_hash, v_previous_occurred
  FROM public.audit_events event
  WHERE event.tenant_id = p_tenant
  ORDER BY event.occurred_at DESC, event.id DESC
  LIMIT 1;
  v_previous_hash := COALESCE(v_previous_hash, repeat('0', 64));
  v_occurred := date_trunc(
    'milliseconds',
    greatest(clock_timestamp(), COALESCE(v_previous_occurred, '-infinity'::timestamptz) + interval '1 millisecond')
  );
  v_occurred_iso := to_char(
    v_occurred AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_canonical_metadata := public.canonical_audit_metadata(COALESCE(p_metadata, '{}'::jsonb));
  v_hash := encode(
    digest(
      convert_to(
        concat_ws(
          chr(31), v_previous_hash, p_tenant::text, p_actor::text,
          p_action, p_target_type, p_target::text, p_outcome,
          v_occurred_iso, p_trace_id, v_canonical_metadata
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.audit_events (
    tenant_id, actor_id, action, target_type, target_id, outcome, trace_id,
    metadata, previous_hash, hash, occurred_at
  ) VALUES (
    p_tenant, p_actor::text, p_action, p_target_type, p_target::text,
    p_outcome::public.audit_outcome, p_trace_id,
    COALESCE(p_metadata, '{}'::jsonb), v_previous_hash, v_hash, v_occurred
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION append_audit_event_secure(uuid, uuid, text, text, uuid, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION decide_document_evidence(
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
    AND document.version = p_version
    AND document.status = 'INDEXED'
    AND document.evidence_status = 'PENDING'
  RETURNING document.id INTO v_document_id;
  IF v_document_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM public.append_audit_event_secure(
    p_tenant,
    p_reviewer,
    CASE p_decision
      WHEN 'APPROVED' THEN 'DOCUMENT_EVIDENCE_APPROVED'
      ELSE 'DOCUMENT_EVIDENCE_REJECTED'
    END,
    'document',
    v_document_id,
    'SUCCESS',
    p_trace_id,
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
REVOKE ALL ON FUNCTION decide_document_evidence(uuid, uuid, uuid, text, text, integer, text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION decide_workpaper_review(
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
      JOIN public.matters matter
        ON matter.tenant_id = workpaper.tenant_id
       AND matter.id = workpaper.matter_id
      WHERE workpaper.tenant_id = approval.tenant_id
        AND workpaper.id = approval.target_id
        AND matter.reviewer_id = p_reviewer
    )
  RETURNING approval.status::text INTO v_decision;
  IF v_decision IS NULL THEN
    RETURN;
  END IF;
  PERFORM public.append_audit_event_secure(
    p_tenant,
    p_reviewer,
    CASE p_decision
      WHEN 'APPROVED' THEN 'WORKPAPER_APPROVED'
      ELSE 'WORKPAPER_REJECTED'
    END,
    'workpaper',
    p_target,
    'SUCCESS',
    p_trace_id,
    jsonb_build_object('artifactHash', p_artifact_hash)
  );
  decision := v_decision;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION decide_workpaper_review(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    REVOKE INSERT, UPDATE, DELETE ON memberships, tenants, users FROM taxops_app;
    REVOKE INSERT, UPDATE, DELETE ON document_chunks FROM taxops_app;
    REVOKE UPDATE ON documents, approvals FROM taxops_app;
    REVOKE INSERT, UPDATE, DELETE ON audit_events FROM taxops_app;
    REVOKE ALL ON FUNCTION decide_document_evidence(uuid, uuid, uuid, text, text, integer, text, text) FROM taxops_app;
    REVOKE ALL ON FUNCTION decide_workpaper_review(uuid, uuid, uuid, text, text, text, text) FROM taxops_app;
    GRANT EXECUTE ON FUNCTION append_audit_event_secure(uuid, uuid, text, text, uuid, text, text, jsonb) TO taxops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_reviewer') THEN
    GRANT USAGE ON SCHEMA public TO taxops_reviewer;
    GRANT SELECT ON documents, document_chunks, matters, users, memberships,
      approvals, workpapers, workpaper_versions, audit_events TO taxops_reviewer;
    REVOKE INSERT, UPDATE, DELETE ON audit_events FROM taxops_reviewer;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO taxops_reviewer;
    GRANT EXECUTE ON FUNCTION append_audit_event_secure(uuid, uuid, text, text, uuid, text, text, jsonb) TO taxops_reviewer;
    GRANT EXECUTE ON FUNCTION decide_document_evidence(uuid, uuid, uuid, text, text, integer, text, text) TO taxops_reviewer;
    GRANT EXECUTE ON FUNCTION decide_workpaper_review(uuid, uuid, uuid, text, text, text, text) TO taxops_reviewer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT UPDATE (object_key, status, indexed_at, updated_at) ON documents TO taxops_worker;
  END IF;
END;
$permissions$;
