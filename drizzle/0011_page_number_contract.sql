ALTER TABLE "document_chunks" DISABLE TRIGGER "document_chunks_content_immutable";
--> statement-breakpoint
UPDATE "document_chunks" SET "page_number" = NULL WHERE "page_number" = 0;
--> statement-breakpoint
ALTER TABLE "document_chunks" ENABLE TRIGGER "document_chunks_content_immutable";
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "chunks_page_number_positive" CHECK ("document_chunks"."page_number" IS NULL OR "document_chunks"."page_number" > 0);
