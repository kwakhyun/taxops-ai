import { createHash } from "node:crypto";

export interface WorkpaperArtifact {
  targetId: string;
  matterId: string;
  title: string;
  version: number;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface ReviewRequest extends WorkpaperArtifact {
  matterId: string;
  client: string;
  taxType: string;
  period: string;
  title: string;
  requestedBy: string;
  reviewer: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  expiresAt: string;
  requestHash: string;
  artifactHash: string;
  stale: boolean;
  decisionNote?: string;
}

export interface WorkpaperEvidenceBinding {
  id: string;
  documentName: string;
  page: number | null;
  section: string | null;
  excerpt: string;
  contentHash: string;
  sourceType: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  jurisdiction: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourcePublisher: string | null;
  sourceUri: string | null;
  acquiredAt: string | null;
}

const evidenceBindingKeys = [
  "id",
  "documentName",
  "page",
  "section",
  "excerpt",
  "contentHash",
  "sourceType",
  "jurisdiction",
  "effectiveFrom",
  "effectiveTo",
  "sourcePublisher",
  "sourceUri",
  "acquiredAt",
] as const;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCanonicalIsoDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function parseEvidenceBinding(
  candidate: unknown,
): WorkpaperEvidenceBinding | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...evidenceBindingKeys].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    typeof record.id !== "string" ||
    !uuidPattern.test(record.id) ||
    typeof record.documentName !== "string" ||
    record.documentName.length === 0 ||
    !(
      record.page === null ||
      (typeof record.page === "number" &&
        Number.isInteger(record.page) &&
        record.page > 0)
    ) ||
    !isNullableString(record.section) ||
    typeof record.excerpt !== "string" ||
    record.excerpt.length === 0 ||
    typeof record.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.contentHash) ||
    !["BUSINESS_RECORD", "TAX_AUTHORITY", "INTERNAL_POLICY"].includes(
      String(record.sourceType),
    ) ||
    typeof record.jurisdiction !== "string" ||
    record.jurisdiction.length === 0 ||
    !isCanonicalIsoDate(record.effectiveFrom) ||
    !isCanonicalIsoDate(record.effectiveTo) ||
    !isNullableString(record.sourcePublisher) ||
    !isNullableString(record.sourceUri) ||
    !isCanonicalIsoDate(record.acquiredAt)
  ) {
    return undefined;
  }
  return record as unknown as WorkpaperEvidenceBinding;
}

export function workpaperEvidenceBindingMatches(
  expected: WorkpaperEvidenceBinding,
  actual: WorkpaperEvidenceBinding,
) {
  return evidenceBindingKeys.every((key) => expected[key] === actual[key]);
}

export function workpaperEvidenceBindings(
  content: Record<string, unknown>,
): WorkpaperEvidenceBinding[] | undefined {
  if (!Array.isArray(content.evidenceIds)) return undefined;
  const evidenceIds = content.evidenceIds;
  if (
    evidenceIds.some((id) => typeof id !== "string" || !uuidPattern.test(id)) ||
    new Set(evidenceIds).size !== evidenceIds.length
  ) {
    return undefined;
  }
  if (evidenceIds.length === 0) return undefined;
  if (!Array.isArray(content.evidence)) return undefined;
  const bindings: WorkpaperEvidenceBinding[] = [];
  for (const candidate of content.evidence) {
    const binding = parseEvidenceBinding(candidate);
    if (!binding) return undefined;
    bindings.push(binding);
  }
  const bindingIds = bindings.map((binding) => binding.id);
  if (
    bindings.length !== evidenceIds.length ||
    new Set(bindingIds).size !== bindingIds.length ||
    [...bindingIds].sort().join("\n") !== [...evidenceIds].sort().join("\n")
  ) {
    return undefined;
  }
  return bindings;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => JSON.stringify(key) + ":" + canonicalize(record[key]))
      .join(",") +
    "}"
  );
}

export function hashWorkpaperArtifact(artifact: WorkpaperArtifact) {
  return createHash("sha256")
    .update(
      canonicalize({
        targetId: artifact.targetId,
        matterId: artifact.matterId,
        title: artifact.title,
        version: artifact.version,
        content: artifact.content,
        provenance: artifact.provenance,
      }),
    )
    .digest("hex");
}
