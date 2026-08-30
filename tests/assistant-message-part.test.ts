import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMessagePart } from "@/components/assistant-message-part";
import type { DynamicToolUIPart } from "ai";

describe("assistant tool progress", () => {
  it.each(["output-error", "output-denied"] as const)(
    "does not show a loading spinner for %s",
    (state) => {
      const shared = {
        type: "dynamic-tool" as const,
        toolName: "searchTaxSources",
        toolCallId: "test-tool-call",
        input: {},
      };
      const part: DynamicToolUIPart =
        state === "output-error"
          ? { ...shared, state, errorText: "Internal error details" }
          : {
              ...shared,
              state,
              approval: { id: "test-approval", approved: false },
            };
      const html = renderToStaticMarkup(
        createElement(AssistantMessagePart, {
          part,
          evidence: [],
          matterId: "vat-2025-q4",
        }),
      );
      expect(html).not.toContain('class="spin"');
      expect(html).not.toContain("Internal error details");
      expect(html).toContain(state === "output-error" ? "실패" : "실행 거부");
    },
  );
});
