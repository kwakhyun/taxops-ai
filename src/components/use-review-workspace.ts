"use client";

import { useMemo, useRef, useState } from "react";
import type { ReviewDecision } from "@/components/review-workspace-model";
import type { ReviewRequest } from "@/lib/workpapers/artifact";

export function useReviewWorkspace(requests: ReviewRequest[]) {
  const [selectedId, setSelectedId] = useState(requests[0]?.targetId);
  const [acting, setActing] = useState<"APPROVED" | "REJECTED">();
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>(
    {},
  );
  const decisionLock = useRef(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState(
    "현재 버전과 출처 이력을 시스템이 확인한 뒤 검토 결과를 기록합니다.",
  );
  const selected = useMemo(
    () => requests.find((item) => item.targetId === selectedId),
    [requests, selectedId],
  );
  const decision = selectedId ? decisions[selectedId] : undefined;
  const currentRequests = requests.map((request) => ({
    ...request,
    status: decisions[request.targetId]?.decision ?? request.status,
  }));

  function recordDecision(targetId: string, value: ReviewDecision) {
    setDecisions((current) => ({ ...current, [targetId]: value }));
  }

  function selectRequest(targetId: string) {
    if (decisionLock.current) return;
    setSelectedId(targetId);
    setNote("");
    setMessage(
      "현재 버전과 출처 이력을 시스템이 확인한 뒤 검토 결과를 기록합니다.",
    );
  }

  async function decide(nextDecision: "APPROVED" | "REJECTED") {
    if (!selected || decisionLock.current) return;
    const normalizedNote = note.trim();
    if (normalizedNote.length < 4) {
      setMessage("검토 근거가 남도록 의견을 4자 이상 입력해 주세요.");
      return;
    }
    decisionLock.current = true;
    setActing(nextDecision);
    setMessage("");
    try {
      const tokenResponse = await fetch("/api/v1/reviews/" + selected.targetId);
      const tokenPayload = (await tokenResponse.json()) as {
        data?: {
          tokens?: Record<"APPROVED" | "REJECTED", string>;
          artifactHash?: string;
          decision?: ReviewDecision;
        };
        error?: { message: string };
      };
      if (tokenPayload.data?.decision) {
        recordDecision(selected.targetId, tokenPayload.data.decision);
        setMessage("이미 처리된 검토 요청입니다.");
        return;
      }
      if (
        !tokenResponse.ok ||
        !tokenPayload.data?.tokens?.[nextDecision] ||
        !tokenPayload.data.artifactHash
      ) {
        throw new Error(tokenPayload.error?.message ?? "승인 권한 확인 실패");
      }
      const response = await fetch("/api/v1/reviews/" + selected.targetId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: nextDecision,
          note: normalizedNote,
          token: tokenPayload.data.tokens[nextDecision],
          artifactHash: tokenPayload.data.artifactHash,
        }),
      });
      const payload = (await response.json()) as {
        data?: ReviewDecision;
        error?: { message: string };
      };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "검토 처리 실패");
      }
      recordDecision(selected.targetId, payload.data);
      setMessage(
        nextDecision === "APPROVED"
          ? "검토조서를 승인했습니다."
          : "검토조서를 반려했습니다.",
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : "검토 결정을 저장하지 못했습니다.",
      );
    } finally {
      decisionLock.current = false;
      setActing(undefined);
    }
  }

  return {
    currentRequests,
    selected,
    acting,
    decision,
    note,
    message,
    setNote,
    selectRequest,
    decide,
  };
}
