type AgentStreamPart = {
  type: string;
  [key: string]: unknown;
};

const clientVisibleTools = new Set([
  "independentReview",
  "deliverVerifiedAnswer",
  "proposeWorkpaper",
  "abstain",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

function stringList(value: unknown, maximum = 20) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, maximum)
    : [];
}

function evidenceProjection(value: unknown) {
  return Array.isArray(value)
    ? value.slice(0, 20).flatMap((candidate) => {
        const item = record(candidate);
        if (!item) return [];
        const id = text(item.id, 120);
        const documentName = text(item.documentName, 300);
        const excerpt = text(item.excerpt, 2_000);
        if (!id || !documentName || !excerpt) return [];
        return [
          {
            id,
            documentName,
            page:
              typeof item.page === "number" && Number.isFinite(item.page)
                ? item.page
                : undefined,
            section: text(item.section, 300),
            excerpt,
            contentHash: text(item.contentHash, 128),
            sourceType: text(item.sourceType, 40),
            jurisdiction: text(item.jurisdiction, 16),
            effectiveFrom: text(item.effectiveFrom, 40),
            effectiveTo: text(item.effectiveTo, 40),
            sourcePublisher: text(item.sourcePublisher, 300),
            acquiredAt: text(item.acquiredAt, 40),
          },
        ];
      })
    : [];
}

function safeToolOutput(toolName: string, value: unknown) {
  const output = record(value);
  if (!output) return undefined;

  if (toolName === "independentReview") {
    if (
      !["SUPPORTED", "NEEDS_REVIEW", "UNSUPPORTED"].includes(
        String(output.verdict),
      )
    ) {
      return undefined;
    }
    return {
      verdict: output.verdict,
      supportedClaimCount:
        typeof output.supportedClaimCount === "number"
          ? output.supportedClaimCount
          : 0,
      totalClaimCount:
        typeof output.totalClaimCount === "number" ? output.totalClaimCount : 0,
    };
  }

  if (toolName === "abstain") {
    return {
      abstained: true,
      message:
        "답변을 보류합니다. 현재 근거와 검증 결과만으로는 안전한 세무 결론을 제시할 수 없습니다.",
      reason: "승인된 근거가 부족하거나 현재 검증 단계를 통과하지 못했습니다.",
      nextAction:
        "관련 자료를 추가하거나 질문 범위를 좁힌 뒤 다시 분석해 주세요.",
    };
  }

  if (toolName === "deliverVerifiedAnswer") {
    if (output.verified !== true || output.requiresHumanReview !== true) {
      return undefined;
    }
    const conclusion = text(output.conclusion, 2_000);
    if (!conclusion) return undefined;
    return {
      verified: true,
      title: "검증된 세무 분석",
      conclusion,
      evidenceIds: stringList(output.evidenceIds),
      evidence: evidenceProjection(output.evidence),
      calculations: Array.isArray(output.calculations)
        ? output.calculations.slice(0, 20)
        : [],
      traceId: text(output.traceId, 120),
      requiresHumanReview: true,
    };
  }

  if (toolName === "proposeWorkpaper") {
    if (
      output.requiresHumanApproval !== true ||
      output.requestedState !== "AWAITING_REVIEW"
    ) {
      return undefined;
    }
    return {
      targetId: text(output.targetId, 120),
      version: typeof output.version === "number" ? output.version : undefined,
      evidenceIds: stringList(output.evidenceIds),
      evidence: evidenceProjection(output.evidence),
      requiresHumanApproval: true,
      requestedState: "AWAITING_REVIEW",
      traceId: text(output.traceId, 120),
    };
  }

  return undefined;
}

function safeLifecyclePart<Part extends AgentStreamPart>(part: Part) {
  if (part.type === "start") return { type: "start" } as unknown as Part;
  if (part.type === "start-step")
    return { type: "start-step", warnings: [] } as unknown as Part;
  if (part.type === "finish-step") {
    return { type: "finish-step" } as unknown as Part;
  }
  if (part.type === "abort") return { type: "abort" } as unknown as Part;
  if (part.type === "error") {
    return {
      type: "error",
      error: new Error("Agent stream failed"),
    } as unknown as Part;
  }
  if (part.type === "finish") {
    return { type: "finish" } as unknown as Part;
  }
  return undefined;
}

/**
 * Exhaustive user-disclosure allowlist. The primary model's text, reasoning,
 * metadata, tool inputs and intermediate tool outputs never cross the HTTP
 * response boundary. Only projected, server-executed terminal tool results and
 * a minimal lifecycle envelope are emitted. Unknown future SDK parts fail shut.
 */
export function verifiedToolOutputOnlyTransform<Part extends AgentStreamPart>(
  _options: unknown,
): TransformStream<Part, Part> {
  void _options;
  const locallyExecutedToolCalls = new Set<string>();
  return new TransformStream<Part, Part>({
    transform(part, controller) {
      const lifecycle = safeLifecyclePart(part);
      if (lifecycle) {
        controller.enqueue(lifecycle);
        return;
      }

      if (part.type === "tool-call") {
        const toolName = text(part.toolName, 80);
        const toolCallId = text(part.toolCallId, 160);
        if (
          !toolName ||
          !toolCallId ||
          part.providerExecuted === true ||
          !clientVisibleTools.has(toolName)
        )
          return;
        locallyExecutedToolCalls.add(toolCallId);
        controller.enqueue({
          type: "tool-call",
          toolCallId,
          toolName,
          input: { redacted: true },
        } as unknown as Part);
        return;
      }

      if (part.type === "tool-result") {
        const toolName = text(part.toolName, 80);
        const toolCallId = text(part.toolCallId, 160);
        if (
          !toolName ||
          !toolCallId ||
          part.providerExecuted === true ||
          !clientVisibleTools.has(toolName) ||
          !locallyExecutedToolCalls.delete(toolCallId)
        )
          return;
        const output = safeToolOutput(toolName, part.output);
        if (!output) return;
        controller.enqueue({
          type: "tool-result",
          toolCallId,
          toolName,
          input: { redacted: true },
          output,
        } as unknown as Part);
      }
    },
  });
}
