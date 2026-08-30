export type ClaimedJob = {
  id: string;
  tenant_id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

export type ClaimedOutbox = {
  id: string;
  tenant_id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
};

export type SourceDocument = {
  id: string;
  object_key: string;
  object_version_id: string | null;
  object_etag: string | null;
  object_checksum_sha256: string | null;
  original_name: string;
  mime_type: string;
  checksum_sha256: string;
  version: number;
  source_type: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  source_publisher: string | null;
  source_uri: string | null;
  acquired_at: Date | null;
  evidence_status: "PENDING" | "APPROVED" | "REJECTED";
};

export class LeaseLostError extends Error {
  constructor() {
    super("Job lease is no longer owned by this worker");
    this.name = "LeaseLostError";
  }
}

export class OutboxLeaseLostError extends Error {
  constructor() {
    super("Outbox lease is no longer owned by this worker");
    this.name = "OutboxLeaseLostError";
  }
}

export class MalwareDetectedError extends Error {
  readonly permanent = true;

  constructor() {
    super("Malware scan rejected the document");
    this.name = "MALWARE_DETECTED";
  }
}
