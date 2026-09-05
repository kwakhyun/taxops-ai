import type { DocumentRecord, MatterAnalysis } from "@/lib/domain/types";

export function filingChecks(
  documents: DocumentRecord[],
  analysis?: MatterAnalysis,
) {
  const run = analysis?.latestRun;
  const verified = Boolean(
    run &&
    ["COMPLETED", "NEEDS_REVIEW"].includes(run.status) &&
    run.evidenceCoverage === 100 &&
    analysis?.workflowSteps.some(
      (step) => step.key === "VERIFY" && step.status === "COMPLETE",
    ),
  );
  const approved = documents.filter(
    (document) =>
      document.status === "INDEXED" && document.evidenceStatus === "APPROVED",
  ).length;
  return [
    {
      label: "등록 자료 처리·승인",
      helper: documents.length
        ? `${documents.length}건 중 ${approved}건 승인`
        : "자료 등록 필요",
      complete: documents.length > 0 && approved === documents.length,
    },
    {
      label: "근거 기반 분석",
      helper: verified
        ? "최신 분석 근거 검증 완료"
        : run?.status === "FAILED"
          ? "최신 분석 실패 · 재실행 필요"
          : "최신 분석의 검증 완료 필요",
      complete: verified,
    },
    {
      label: "전문가 검토·승인",
      helper:
        analysis?.workpaper?.reviewStatus === "REJECTED"
          ? "반려 · 보완 필요"
          : verified &&
              run?.status === "COMPLETED" &&
              analysis?.workpaper?.reviewStatus === "APPROVED"
            ? "최신 분석 조서 승인 완료"
            : "최신 분석 조서 승인 필요",
      complete:
        verified &&
        run?.status === "COMPLETED" &&
        analysis?.workpaper?.reviewStatus === "APPROVED",
    },
    {
      label: "실행 이력·감사 추적",
      helper: run?.traceId ? `추적 ID ${run.traceId}` : "실행 이력 대기",
      complete: Boolean(run?.traceId),
    },
  ];
}
