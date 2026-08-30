import { describe, expect, it } from "vitest";
import { assistantErrorMessage } from "@/components/assistant-message-model";

describe("assistant error presentation", () => {
  it("shows a useful API message without the JSON envelope", () => {
    expect(
      assistantErrorMessage(
        new Error(
          JSON.stringify({
            error: {
              code: "AI_UNAVAILABLE",
              message: "잠시 후 다시 시도해 주세요.",
            },
            meta: { requestId: "internal-request-id" },
          }),
        ),
      ),
    ).toBe("잠시 후 다시 시도해 주세요.");
  });

  it("localizes validation and transport failures", () => {
    expect(
      assistantErrorMessage(
        new Error(
          JSON.stringify({
            error: {
              code: "VALIDATION_ERROR",
              message: "Request validation failed",
            },
          }),
        ),
      ),
    ).toContain("2,000자");
    expect(assistantErrorMessage(new Error("Failed to fetch"))).toBe(
      "응답을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    );
    expect(assistantErrorMessage(new Error("근거 자료를 확인해 주세요."))).toBe(
      "근거 자료를 확인해 주세요.",
    );
  });
});
