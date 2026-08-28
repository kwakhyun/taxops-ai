ALTER TABLE "documents" ADD COLUMN "object_version_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "object_etag" varchar(200);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "object_checksum_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_object_checksum_valid" CHECK ("documents"."object_checksum_sha256" IS NULL OR "documents"."object_checksum_sha256" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_object_binding_complete" CHECK (("documents"."object_version_id" IS NULL AND "documents"."object_etag" IS NULL AND "documents"."object_checksum_sha256" IS NULL) OR ("documents"."object_version_id" IS NOT NULL AND "documents"."object_etag" IS NOT NULL AND "documents"."object_checksum_sha256" IS NOT NULL));
--> statement-breakpoint
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'taxops_worker') THEN
    GRANT UPDATE (
      object_version_id, object_etag, object_checksum_sha256
    ) ON documents TO taxops_worker;
  END IF;
END;
$permissions$;
