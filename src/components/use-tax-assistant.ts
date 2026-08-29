"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useMemo } from "react";
import {
  currentAssistantStage,
  extractCitedEvidenceIds,
  latestAssistantVerification,
  streamedAssistantEvidence,
  type AssistantEvidence,
} from "@/components/assistant-message-model";
import type { TaxAssistantMessage } from "@/lib/ai/types";

export function useTaxAssistant({
  matterId,
  initialEvidence,
}: {
  matterId: string;
  initialEvidence: AssistantEvidence[];
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport<TaxAssistantMessage>({
        api: "/api/v1/assistant",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages, matterId },
        }),
      }),
    [matterId],
  );
  const chat = useChat<TaxAssistantMessage>({
    id: `taxops-${matterId}`,
    transport,
  });
  const busy = chat.status === "submitted" || chat.status === "streaming";
  const latestMessage = chat.messages.at(-1);
  const currentStage = useMemo(
    () => currentAssistantStage(chat.messages),
    [chat.messages],
  );
  const streamedEvidence = useMemo(
    () => streamedAssistantEvidence(latestMessage),
    [latestMessage],
  );
  const latestVerification = useMemo(
    () => latestAssistantVerification(latestMessage),
    [latestMessage],
  );
  const panelEvidence = useMemo(() => {
    const citedEvidenceIds = extractCitedEvidenceIds(latestMessage);
    const citedStreamedEvidence = citedEvidenceIds.length
      ? streamedEvidence.filter((item) => citedEvidenceIds.includes(item.id))
      : streamedEvidence;
    return citedStreamedEvidence.length
      ? citedStreamedEvidence
      : chat.messages.length
        ? []
        : initialEvidence;
  }, [chat.messages.length, initialEvidence, latestMessage, streamedEvidence]);

  return {
    ...chat,
    busy,
    currentStage,
    streamedEvidence,
    latestVerification,
    panelEvidence,
  };
}
