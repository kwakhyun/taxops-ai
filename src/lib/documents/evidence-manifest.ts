import { createHash } from "node:crypto";

export interface EvidenceManifestChunk {
  id: string;
  chunkIndex: number;
  contentHash: string;
  sourceType?: string;
  jurisdiction?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export function evidenceManifestHash(input: {
  documentId: string;
  version: number;
  sourceChecksumSha256: string;
  sourcePublisher?: string | null;
  sourceUri?: string | null;
  acquiredAt?: string | null;
  chunks: ReadonlyArray<EvidenceManifestChunk>;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        documentId: input.documentId,
        version: input.version,
        sourceChecksumSha256: input.sourceChecksumSha256,
        sourcePublisher: input.sourcePublisher ?? null,
        sourceUri: input.sourceUri ?? null,
        acquiredAt: input.acquiredAt ?? null,
        chunks: input.chunks
          .toSorted((left, right) =>
            left.chunkIndex === right.chunkIndex
              ? left.id.localeCompare(right.id)
              : left.chunkIndex - right.chunkIndex,
          )
          .map((chunk) => ({
            id: chunk.id,
            chunkIndex: chunk.chunkIndex,
            contentHash: chunk.contentHash,
            sourceType: chunk.sourceType ?? "BUSINESS_RECORD",
            jurisdiction: chunk.jurisdiction ?? "KR",
            effectiveFrom: chunk.effectiveFrom ?? null,
            effectiveTo: chunk.effectiveTo ?? null,
          })),
      }),
    )
    .digest("hex");
}
