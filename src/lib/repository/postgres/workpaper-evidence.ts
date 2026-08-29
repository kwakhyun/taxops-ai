import type { WorkpaperEvidenceBinding } from "@/lib/workpapers/artifact";

export interface WorkpaperEvidenceRow {
  id: string;
  document_name: string;
  page_number: number | null;
  section: string | null;
  excerpt: string;
  content_hash: string;
  source_type: WorkpaperEvidenceBinding["sourceType"];
  jurisdiction: string;
  effective_from: Date | null;
  effective_to: Date | null;
  source_publisher: string | null;
  source_uri: string | null;
  acquired_at: Date | null;
}

export function mapWorkpaperEvidenceBinding(
  row: WorkpaperEvidenceRow,
): WorkpaperEvidenceBinding {
  return {
    id: row.id,
    documentName: row.document_name,
    page: row.page_number,
    section: row.section,
    excerpt: row.excerpt,
    contentHash: row.content_hash,
    sourceType: row.source_type,
    jurisdiction: row.jurisdiction,
    effectiveFrom: row.effective_from?.toISOString() ?? null,
    effectiveTo: row.effective_to?.toISOString() ?? null,
    sourcePublisher: row.source_publisher,
    sourceUri: row.source_uri,
    acquiredAt: row.acquired_at?.toISOString() ?? null,
  };
}
