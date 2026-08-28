ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_content_hash_matches" CHECK ("document_chunks"."content_hash" = encode(digest(convert_to("document_chunks"."content", 'UTF8'), 'sha256'), 'hex'));
--> statement-breakpoint
CREATE FUNCTION worker_operational_metrics()
RETURNS TABLE(queue_oldest_seconds bigint, dead_jobs bigint, stuck_outbox bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF session_user <> 'taxops_worker' THEN
    RAISE insufficient_privilege USING MESSAGE = 'worker metrics are not allowed';
  END IF;
  RETURN QUERY
  SELECT
    COALESCE(max(extract(epoch FROM now() - job.created_at))
      FILTER (WHERE job.status IN ('QUEUED', 'RETRYING')), 0)::bigint,
    count(*) FILTER (WHERE job.status = 'DEAD')::bigint,
    (SELECT count(*)::bigint FROM public.outbox_events event
      WHERE event.published_at IS NULL AND event.attempts >= 10)
  FROM public.jobs job;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION worker_operational_metrics() FROM PUBLIC;
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT EXECUTE ON FUNCTION worker_operational_metrics() TO taxops_worker;
  END IF;
END;
$permissions$;
