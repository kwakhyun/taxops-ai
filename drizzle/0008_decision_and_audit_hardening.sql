CREATE OR REPLACE FUNCTION verify_audit_chain_integrity(p_tenant uuid)
RETURNS TABLE(
  valid boolean,
  event_count bigint,
  root_previous_hash text,
  head_hash text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user NOT IN ('taxops_app', 'taxops_reviewer')
     OR p_tenant IS NULL
     OR nullif(current_setting('app.tenant_id', true), '')::uuid
        IS DISTINCT FROM p_tenant THEN
    RAISE insufficient_privilege
      USING MESSAGE = 'audit verifier tenant context is not allowed';
  END IF;

  RETURN QUERY
  WITH ordered_events AS (
    SELECT
      event.*,
      lag(event.hash) OVER (
        ORDER BY event.occurred_at ASC, event.id ASC
      ) AS expected_previous_hash
    FROM public.audit_events event
    WHERE event.tenant_id = p_tenant
  ), checked_events AS (
    SELECT
      event.*,
      CASE
        WHEN event.expected_previous_hash IS NULL
          THEN event.previous_hash = repeat('0', 64)
        ELSE event.previous_hash = event.expected_previous_hash
      END AS link_is_valid,
      event.hash = encode(
        digest(
          convert_to(
            concat_ws(
              chr(31), event.previous_hash, event.tenant_id::text,
              event.actor_id, event.action, event.target_type,
              event.target_id, event.outcome::text,
              to_char(
                event.occurred_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ),
              event.trace_id,
              public.canonical_audit_metadata(event.metadata)
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      ) AS payload_is_valid
    FROM ordered_events event
  )
  SELECT
    count(*) > 0
      AND COALESCE(bool_and(event.link_is_valid), false)
      AND COALESCE(bool_and(event.payload_is_valid), false) AS valid,
    count(*)::bigint AS event_count,
    (array_agg(
      event.previous_hash ORDER BY event.occurred_at ASC, event.id ASC
    ))[1]::text AS root_previous_hash,
    (array_agg(
      event.hash ORDER BY event.occurred_at DESC, event.id DESC
    ))[1]::text AS head_hash
  FROM checked_events event;
END;
$$;
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
     OR nullif(current_setting('app.tenant_id', true), '')::uuid
        IS DISTINCT FROM p_tenant
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
    AND document.object_checksum_sha256 = p_checksum
    AND document.object_version_id IS NOT NULL
    AND document.object_etag IS NOT NULL
    AND document.evidence_manifest_sha256 = p_manifest_hash
    AND document.version = p_version
    AND document.status = 'INDEXED'
    AND document.injection_scan_status = 'SAFE'
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
CREATE FUNCTION workpaper_evidence_is_current(
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
    session_user = 'taxops_reviewer'
    AND nullif(current_setting('app.tenant_id', true), '')::uuid = p_tenant
    AND shape.ids_are_an_array
    AND (shape.id_count = 0 OR shape.evidence_is_an_array)
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
      WHERE jsonb_typeof(binding.value) <> 'object'
         OR binding.value->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR binding.value->>'contentHash' !~ '^[a-f0-9]{64}$'
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
         AND chunk.content_hash = binding.value->>'contentHash'
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
      )
    ) = shape.id_count
  FROM shape;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workpaper_evidence_is_current(uuid, uuid, jsonb) FROM PUBLIC;
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
        AND public.workpaper_evidence_is_current(
          approval.tenant_id, workpaper.matter_id, version.content
        )
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
