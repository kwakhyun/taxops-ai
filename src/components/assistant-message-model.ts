import { getToolName, isToolUIPart } from "ai";
import type { TaxAssistantMessage } from "@/lib/ai/types";

export type AssistantEvidence = {
  id: string;
  documentName: string;
  location: string;
  excerpt: string;
  score: number;
  contentHash: string;
};

export type DisplayEvidence = Pick<
  AssistantEvidence,
  "id" | "documentName" | "location" | "excerpt"
>;

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function evidenceSnapshot(value: unknown): DisplayEvidence[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const item = objectValue(candidate);
        return item &&
          typeof item.id === "string" &&
          typeof item.documentName === "string" &&
          typeof item.excerpt === "string"
          ? [
              {
                id: item.id,
                documentName: item.documentName,
                location: item.page
                  ? `${String(item.page)}쪽 · ${String(item.section ?? "문서 본문")}`
                  : String(item.section ?? "문서 본문"),
                excerpt: item.excerpt,
              },
            ]
          : [];
      })
    : [];
}

export function extractCitedEvidenceIds(message?: TaxAssistantMessage) {
  if (message?.role !== "assistant") return [];
  for (const part of message.parts.toReversed()) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;
    const name = getToolName(part);
    if (name !== "deliverVerifiedAnswer" && name !== "proposeWorkpaper") {
      continue;
    }
    const output = objectValue(part.output);
    if (!Array.isArray(output?.evidenceIds)) return [];
    return output.evidenceIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  return [];
}

export function currentAssistantStage(messages: TaxAssistantMessage[]) {
  for (const message of messages.toReversed()) {
    for (const part of message.parts.toReversed()) {
      if (part.type === "data-workflow") return part.data.stage;
    }
  }
  return undefined;
}

export function streamedAssistantEvidence(message?: TaxAssistantMessage) {
  if (message?.role !== "assistant") return [];
  return message.parts.flatMap((part): AssistantEvidence[] => {
    if (part.type === "data-evidence") {
      return [
        {
          id: part.data.id,
          documentName: part.data.documentName,
          location: part.data.location,
          excerpt: part.data.excerpt,
          score: part.data.score,
          contentHash: part.data.id,
        },
      ];
    }
    if (
      isToolUIPart(part) &&
      [
        "searchTaxSources",
        "deliverVerifiedAnswer",
        "proposeWorkpaper",
      ].includes(getToolName(part)) &&
      part.state === "output-available"
    ) {
      const output = objectValue(part.output);
      const values = Array.isArray(part.output)
        ? part.output
        : Array.isArray(output?.evidence)
          ? output.evidence
          : [];
      return values.flatMap((value): AssistantEvidence[] => {
        const item = objectValue(value);
        return item &&
          typeof item.id === "string" &&
          typeof item.documentName === "string" &&
          typeof item.excerpt === "string"
          ? [
              {
                id: item.id,
                documentName: item.documentName,
                location: String(item.location ?? "문서 본문"),
                excerpt: item.excerpt,
                score: Number(item.score ?? 0),
                contentHash: String(item.contentHash ?? item.id),
              },
            ]
          : [];
      });
    }
    return [];
  });
}

export function latestAssistantVerification(message?: TaxAssistantMessage) {
  if (message?.role !== "assistant") return undefined;
  for (const part of message.parts.toReversed()) {
    if (part.type === "data-verification") return part.data;
  }
  return undefined;
}
