CREATE OR REPLACE FUNCTION workpaper_evidence_is_current(
  p_tenant uuid,
  p_matter uuid,
  p_content jsonb
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH normalized AS (
    SELECT
      CASE
        WHEN jsonb_typeof(p_content->'evidenceIds') = 'array'
          THEN p_content->'evidenceIds'
        ELSE '[]'::jsonb
      END AS evidence_ids,
      CASE
        WHEN jsonb_typeof(p_content->'evidence') = 'array'
          THEN p_content->'evidence'
        ELSE '[]'::jsonb
      END AS evidence,
      jsonb_typeof(p_content->'evidenceIds') = 'array' AS ids_are_an_array,
      jsonb_typeof(p_content->'evidence') = 'array' AS evidence_is_an_array
  ), shape AS (
    SELECT
      normalized.*,
      jsonb_array_length(normalized.evidence_ids) AS id_count,
      jsonb_array_length(normalized.evidence) AS evidence_count
    FROM normalized
  )
  SELECT
    session_user IN ('taxops_app', 'taxops_reviewer')
    AND nullif(current_setting('app.tenant_id', true), '')::uuid = p_tenant
    AND shape.ids_are_an_array
    AND shape.evidence_is_an_array
    AND shape.id_count > 0
    AND shape.id_count = shape.evidence_count
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(shape.evidence_ids) evidence_id(value)
      WHERE evidence_id.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    AND (
      SELECT count(*) = count(DISTINCT evidence_id.value)
      FROM jsonb_array_elements_text(shape.evidence_ids) evidence_id(value)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(shape.evidence) binding(value)
      WHERE CASE
        WHEN jsonb_typeof(binding.value) <> 'object' THEN true
        ELSE
          (SELECT count(*) FROM jsonb_object_keys(binding.value)) <> 13
          OR NOT binding.value ?& ARRAY[
            'id', 'documentName', 'page', 'section', 'excerpt',
            'contentHash', 'sourceType', 'jurisdiction', 'effectiveFrom',
            'effectiveTo', 'sourcePublisher', 'sourceUri', 'acquiredAt'
          ]::text[]
          OR jsonb_typeof(binding.value->'id') <> 'string'
          OR binding.value->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR jsonb_typeof(binding.value->'documentName') <> 'string'
          OR jsonb_typeof(binding.value->'page') NOT IN ('number', 'null')
          OR jsonb_typeof(binding.value->'section') NOT IN ('string', 'null')
          OR jsonb_typeof(binding.value->'excerpt') <> 'string'
          OR jsonb_typeof(binding.value->'contentHash') <> 'string'
          OR binding.value->>'contentHash' !~ '^[a-f0-9]{64}$'
          OR jsonb_typeof(binding.value->'sourceType') <> 'string'
          OR binding.value->>'sourceType' NOT IN (
            'BUSINESS_RECORD', 'TAX_AUTHORITY', 'INTERNAL_POLICY'
          )
          OR jsonb_typeof(binding.value->'jurisdiction') <> 'string'
          OR jsonb_typeof(binding.value->'effectiveFrom') NOT IN ('string', 'null')
          OR jsonb_typeof(binding.value->'effectiveTo') NOT IN ('string', 'null')
          OR jsonb_typeof(binding.value->'sourcePublisher') NOT IN ('string', 'null')
          OR jsonb_typeof(binding.value->'sourceUri') NOT IN ('string', 'null')
          OR jsonb_typeof(binding.value->'acquiredAt') NOT IN ('string', 'null')
      END
    )
    AND (
      SELECT count(*) = count(DISTINCT binding.value->>'id')
      FROM jsonb_array_elements(shape.evidence) binding(value)
    )
    AND (
      SELECT count(*)
      FROM jsonb_array_elements_text(shape.evidence_ids) evidence_id(value)
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(shape.evidence) binding(value)
        JOIN public.document_chunks chunk
          ON chunk.id::text = binding.value->>'id'
        JOIN public.documents document
          ON document.tenant_id = chunk.tenant_id
         AND document.id = chunk.document_id
         AND document.matter_id = chunk.matter_id
         AND document.version = chunk.document_version
        WHERE binding.value->>'id' = evidence_id.value
          AND chunk.tenant_id = p_tenant
          AND chunk.matter_id = p_matter
          AND chunk.is_current = true
          AND document.status = 'INDEXED'
          AND document.evidence_status = 'APPROVED'
          AND document.injection_scan_status = 'SAFE'
          AND document.object_version_id IS NOT NULL
          AND document.object_etag IS NOT NULL
          AND document.object_checksum_sha256 = document.checksum_sha256
          AND binding.value->>'documentName' = document.original_name
          AND binding.value->'page' = COALESCE(
            to_jsonb(chunk.page_number), 'null'::jsonb
          )
          AND binding.value->'section' = COALESCE(
            to_jsonb(chunk.section), 'null'::jsonb
          )
          AND binding.value->>'excerpt' = chunk.content
          AND binding.value->>'contentHash' = chunk.content_hash
          AND binding.value->>'sourceType' = chunk.source_type::text
          AND binding.value->>'jurisdiction' = chunk.jurisdiction
          AND binding.value->>'effectiveFrom' IS NOT DISTINCT FROM
            CASE WHEN chunk.effective_from IS NULL THEN NULL ELSE to_char(
              chunk.effective_from AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) END
          AND binding.value->>'effectiveTo' IS NOT DISTINCT FROM
            CASE WHEN chunk.effective_to IS NULL THEN NULL ELSE to_char(
              chunk.effective_to AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) END
          AND binding.value->>'sourcePublisher'
            IS NOT DISTINCT FROM document.source_publisher
          AND binding.value->>'sourceUri'
            IS NOT DISTINCT FROM document.source_uri
          AND binding.value->>'acquiredAt' IS NOT DISTINCT FROM
            CASE WHEN document.acquired_at IS NULL THEN NULL ELSE to_char(
              document.acquired_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) END
      )
    ) = shape.id_count
  FROM shape;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workpaper_evidence_is_current(uuid, uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION create_workpaper_review_request(
  p_tenant uuid,
  p_matter uuid,
  p_actor uuid,
  p_run uuid,
  p_trace_id text,
  p_title text,
  p_content jsonb,
  p_provenance jsonb,
  p_artifact_hash text,
  p_target uuid
) RETURNS TABLE(target_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reviewer uuid;
  v_inserted uuid;
BEGIN
  IF session_user <> 'taxops_app'
     OR nullif(current_setting('app.tenant_id', true), '')::uuid
        IS DISTINCT FROM p_tenant
     OR p_trace_id IS NULL
     OR char_length(p_trace_id) NOT BETWEEN 8 AND 80
     OR p_title IS NULL
     OR char_length(p_title) NOT BETWEEN 1 AND 500
     OR p_artifact_hash !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(p_content) <> 'object'
     OR jsonb_typeof(p_provenance) <> 'object'
     OR p_provenance->>'runId' IS DISTINCT FROM p_run::text
     OR p_provenance->>'traceId' IS DISTINCT FROM p_trace_id
     OR NOT public.workpaper_evidence_is_current(
       p_tenant, p_matter, p_content
     ) THEN
    RETURN;
  END IF;

  SELECT matter.reviewer_id
  INTO v_reviewer
  FROM public.matters matter
  JOIN public.agent_runs run
    ON run.tenant_id = matter.tenant_id
   AND run.matter_id = matter.id
  JOIN public.memberships membership
    ON membership.tenant_id = matter.tenant_id
   AND membership.user_id = p_actor
   AND membership.role IN ('ANALYST', 'ADMIN')
  WHERE matter.tenant_id = p_tenant
    AND matter.id = p_matter
    AND matter.reviewer_id <> p_actor
    AND run.id = p_run
    AND run.actor_id = p_actor
    AND run.trace_id = p_trace_id
    AND run.workflow_status IN ('INTAKE', 'VERIFY')
    AND run.completed_at IS NULL
  FOR UPDATE OF run;
  IF v_reviewer IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.workpapers (
    id, tenant_id, matter_id, title, current_version, created_by
  ) VALUES (
    p_target, p_tenant, p_matter, p_title, 1, p_actor
  ) RETURNING id INTO v_inserted;

  INSERT INTO public.workpaper_versions (
    tenant_id, workpaper_id, version, content, provenance, artifact_hash,
    created_by
  ) VALUES (
    p_tenant, p_target, 1, p_content, p_provenance, p_artifact_hash, p_actor
  );

  INSERT INTO public.approvals (
    tenant_id, target_type, target_id, requested_by, reviewer_id,
    request_hash, target_version, expires_at
  ) VALUES (
    p_tenant, 'workpaper', p_target, p_actor, v_reviewer,
    p_artifact_hash, 1, now() + interval '7 days'
  );

  UPDATE public.agent_runs
  SET workflow_status = 'AWAITING_REVIEW'
  WHERE tenant_id = p_tenant
    AND id = p_run
    AND matter_id = p_matter
    AND actor_id = p_actor
    AND trace_id = p_trace_id
    AND workflow_status IN ('INTAKE', 'VERIFY')
    AND completed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run changed during workpaper creation';
  END IF;

  PERFORM public.append_application_audit_event(
    p_tenant, p_actor, 'WORKPAPER_REVIEW_REQUESTED', 'workpaper',
    p_target, 'SUCCESS', p_trace_id,
    jsonb_build_object('runId', p_run::text, 'version', 1)
  );
  target_id := v_inserted;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_workpaper_review_request(
  uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, text, uuid
) FROM PUBLIC;
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
  v_approval uuid;
  v_run uuid;
  v_decision text;
BEGIN
  IF session_user <> 'taxops_reviewer'
     OR nullif(current_setting('app.tenant_id', true), '')::uuid
        IS DISTINCT FROM p_tenant
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

  SELECT approval.id, run.id
  INTO v_approval, v_run
  FROM public.approvals approval
  JOIN public.workpapers workpaper
    ON workpaper.tenant_id = approval.tenant_id
   AND workpaper.id = approval.target_id
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
  WHERE approval.tenant_id = p_tenant
    AND approval.target_id = p_target
    AND approval.reviewer_id = p_reviewer
    AND approval.requested_by <> p_reviewer
    AND approval.target_type = 'workpaper'
    AND approval.request_hash = p_artifact_hash
    AND approval.expires_at > now()
    AND approval.status = 'PENDING'
    AND matter.reviewer_id = p_reviewer
    AND approval.target_version = workpaper.current_version
    AND version.artifact_hash = p_artifact_hash
    AND run.workflow_status = 'AWAITING_REVIEW'
    AND run.completed_at IS NOT NULL
    AND run.error_code IS NULL
    AND public.workpaper_evidence_is_current(
      approval.tenant_id, workpaper.matter_id, version.content
    )
  FOR UPDATE OF approval, run;
  IF v_approval IS NULL OR v_run IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.approvals approval
  SET status = p_decision::public.approval_status,
      decision_note = p_note,
      decided_at = now(),
      updated_at = now()
  WHERE approval.id = v_approval
    AND approval.tenant_id = p_tenant
    AND approval.status = 'PENDING'
  RETURNING approval.status::text INTO v_decision;
  IF v_decision IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.agent_runs run
  SET workflow_status = p_decision::public.workflow_status
  WHERE run.tenant_id = p_tenant
    AND run.id = v_run
    AND run.workflow_status = 'AWAITING_REVIEW'
    AND run.completed_at IS NOT NULL
    AND run.error_code IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent run changed during review decision';
  END IF;

  PERFORM public.append_audit_event_secure(
    p_tenant, p_reviewer,
    CASE p_decision WHEN 'APPROVED' THEN 'WORKPAPER_APPROVED'
                    ELSE 'WORKPAPER_REJECTED' END,
    'workpaper', p_target, 'SUCCESS', p_trace_id,
    jsonb_build_object(
      'artifactHash', p_artifact_hash,
      'runId', v_run::text,
      'workflowStatus', p_decision
    )
  );
  decision := v_decision;
  RETURN NEXT;
END;
$$;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_app') THEN
    REVOKE INSERT, UPDATE, DELETE
      ON workpapers, workpaper_versions, approvals FROM taxops_app;
    GRANT EXECUTE ON FUNCTION create_workpaper_review_request(
      uuid, uuid, uuid, uuid, text, text, jsonb, jsonb, text, uuid
    ) TO taxops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_reviewer') THEN
    GRANT EXECUTE ON FUNCTION decide_workpaper_review(
      uuid, uuid, uuid, text, text, text, text
    ) TO taxops_reviewer;
  END IF;
END;
$permissions$;
