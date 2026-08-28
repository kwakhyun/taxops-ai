import { safeValidateUIMessages } from "ai";
import { z } from "zod";
import type { TaxAssistantMessage } from "@/lib/ai/types";

export class AssistantMessageValidationError extends Error {
  readonly status = 400;
  readonly code = "INVALID_AI_MESSAGES";

  constructor(message = "AI message payload is invalid") {
    super(message);
    this.name = "AssistantMessageValidationError";
  }
}

const questionSchema = z.string().trim().min(1).max(2_000);

export async function normalizeAssistantMessages(messages: unknown) {
  const validation = await safeValidateUIMessages<TaxAssistantMessage>({
    messages,
  });
  if (!validation.success) throw new AssistantMessageValidationError();

  const lastUserMessage = validation.data
    .toReversed()
    .find((message) => message.role === "user");
  const question = questionSchema.safeParse(
    lastUserMessage?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ") ?? "",
  );
  if (!question.success) {
    throw new AssistantMessageValidationError(
      "질문은 1자 이상 2,000자 이하여야 합니다.",
    );
  }

  // Conversation history, assistant parts and tool outputs are server-owned.
  // The API accepts only the latest user text and reconstructs a clean prompt.
  const normalized: TaxAssistantMessage[] = [
    {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: question.data }],
    },
  ];
  return { question: question.data, messages: normalized };
}
