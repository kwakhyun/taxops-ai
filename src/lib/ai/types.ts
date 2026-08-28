import type { UIMessage } from "ai";
import type { createTaxTools } from "@/lib/ai/tools";
import type { InferUITools } from "ai";

export interface TaxMessageMetadata {
  traceId?: string;
  model?: string;
  promptVersion?: string;
  totalTokens?: number;
  estimatedCostKrw?: number;
}

export type TaxDataParts = {
  workflow: {
    stage: "INTAKE" | "RETRIEVE" | "DRAFT" | "VERIFY" | "AWAITING_REVIEW";
    label: string;
    status: "running" | "complete";
    traceId: string;
  };
  evidence: {
    id: string;
    documentName: string;
    location: string;
    excerpt: string;
    score: number;
  };
  verification: {
    supportedClaims: number;
    totalClaims: number;
    coverage: number;
    status: "verified" | "needs-review";
  };
  budget: {
    latencyMs: number;
    tokens: number;
    estimatedCostKrw: number;
    model: string;
    promptVersion: string;
  };
};

export type TaxAssistantMessage = UIMessage<
  TaxMessageMetadata,
  TaxDataParts,
  InferUITools<ReturnType<typeof createTaxTools>>
>;
