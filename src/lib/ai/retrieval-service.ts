import "server-only";

import { embed } from "ai";
import { retrieveEvidence } from "@/lib/ai/retrieval";
import {
  protectAiOutbound,
  protectAiOutboundBatch,
  protectAiOutboundWithDlp,
  type TenantAiPolicy,
} from "@/lib/security/ai-policy";
import { detectUntrustedSourceInstruction } from "@/lib/ai/guardrails";
import { classifyUntrustedSourceBatch } from "@/lib/security/injection-classifier";
import {
  decodeSourceUriForInspection,
  normalizeTrustedSourceUri,
} from "@/lib/security/source-provenance";

type SourceControlledEvidence = {
  documentName: string;
  section: string;
  excerpt: string;
  sourcePublisher?: string | null;
  sourceUri?: string | null;
};

function normalizedSourceUri(value: string | null | undefined) {
  if (!value) return null;
  try {
    return normalizeTrustedSourceUri(value);
  } catch {
    return undefined;
  }
}

export function protectRetrievedEvidence<T extends SourceControlledEvidence>(
  items: T[],
  aiPolicy: TenantAiPolicy,
) {
  return items.flatMap((item) => {
    const sourceUri = normalizedSourceUri(item.sourceUri);
    if (sourceUri === undefined) return [];
    const documentName = protectAiOutbound(item.documentName, aiPolicy).slice(
      0,
      180,
    );
    const section = protectAiOutbound(item.section, aiPolicy).slice(0, 300);
    const excerpt = protectAiOutbound(item.excerpt, aiPolicy);
    const sourcePublisher = item.sourcePublisher
      ? protectAiOutbound(item.sourcePublisher, aiPolicy).slice(0, 200)
      : null;
    const uriInspection = sourceUri
      ? decodeSourceUriForInspection(sourceUri)
      : "";
    // Every source-controlled label is untrusted. A filename or parser-created
    // section can carry the same instructions as body text.
    return [
      documentName,
      section,
      excerpt,
      sourcePublisher ?? "",
      uriInspection,
    ].some(detectUntrustedSourceInstruction)
      ? []
      : [
          {
            ...item,
            documentName,
            section,
            excerpt,
            ...(Object.hasOwn(item, "sourcePublisher")
              ? { sourcePublisher }
              : {}),
            ...(Object.hasOwn(item, "sourceUri") ? { sourceUri } : {}),
          } as T,
        ];
  });
}

async function protectRetrievedEvidenceForProvider<
  T extends SourceControlledEvidence,
>(items: T[], aiPolicy: TenantAiPolicy) {
  const normalizedUris = items.map((item) =>
    normalizedSourceUri(item.sourceUri),
  );
  const eligibleItems = items.filter(
    (_, index) => normalizedUris[index] !== undefined,
  );
  const eligibleUris = normalizedUris.filter(
    (value): value is string | null => value !== undefined,
  );
  if (eligibleItems.length === 0) return [];
  const protectedFields = await protectAiOutboundBatch(
    eligibleItems.flatMap((item, index) => [
      item.documentName,
      item.section,
      item.excerpt,
      item.sourcePublisher ?? "",
      eligibleUris[index] ?? "",
      eligibleUris[index]
        ? decodeSourceUriForInspection(eligibleUris[index]!)
        : "",
    ]),
    aiPolicy,
    { truncate: false },
  );
  const classifications = await classifyUntrustedSourceBatch(
    protectedFields,
    aiPolicy,
  );
  return eligibleItems.flatMap((item, index) => {
    const documentName = protectedFields[index * 6]!.slice(0, 180);
    const section = protectedFields[index * 6 + 1]!.slice(0, 300);
    const excerpt = protectedFields[index * 6 + 2]!.slice(
      0,
      aiPolicy.maxExcerptChars,
    );
    const sourcePublisher = protectedFields[index * 6 + 3]!.slice(0, 200);
    const protectedUri = protectedFields[index * 6 + 4]!;
    const uriInspection = protectedFields[index * 6 + 5]!;
    const sourceUri =
      eligibleUris[index] && protectedUri === eligibleUris[index]
        ? eligibleUris[index]
        : null;
    const sourceFields = [
      documentName,
      section,
      excerpt,
      sourcePublisher,
      uriInspection,
    ];
    const semanticClassifications = classifications.items.slice(
      index * 6,
      index * 6 + 6,
    );
    return sourceFields.some(detectUntrustedSourceInstruction) ||
      semanticClassifications.some((result) => result.label === "SUSPICIOUS")
      ? []
      : [
          {
            ...item,
            documentName,
            section,
            excerpt,
            ...(Object.hasOwn(item, "sourcePublisher")
              ? { sourcePublisher: sourcePublisher || null }
              : {}),
            ...(Object.hasOwn(item, "sourceUri") ? { sourceUri } : {}),
          } as T,
        ];
  });
}

export async function retrieveEvidenceForContext(input: {
  tenantId: string;
  matterId: string;
  taxReferenceDate: string;
  query: string;
  limit?: number;
  aiPolicy: TenantAiPolicy;
}) {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 8);
  const protectedQuery = await protectAiOutboundWithDlp(
    input.query,
    input.aiPolicy,
    {
      truncate: false,
    },
  );
  if (!process.env.DATABASE_URL) {
    return protectRetrievedEvidenceForProvider(
      retrieveEvidence({ ...input, query: protectedQuery, limit }),
      input.aiPolicy,
    );
  }

  let embedding: number[] | undefined;
  if (process.env.AI_GATEWAY_API_KEY) {
    const result = await embed({
      model:
        process.env.AI_EMBEDDING_MODEL_ID ?? "openai/text-embedding-3-small",
      value: protectedQuery,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(5_000),
      telemetry: {
        isEnabled: true,
        recordInputs: false,
        recordOutputs: false,
        functionId: "taxops.retrieval.embed-query",
      },
    });
    embedding = result.embedding;
  }

  const { searchEvidence } = await import("@/lib/repository");
  return protectRetrievedEvidenceForProvider(
    await searchEvidence({
      ...input,
      query: protectedQuery,
      limit,
      embedding,
      taxReferenceDate: input.taxReferenceDate,
    }),
    input.aiPolicy,
  );
}
