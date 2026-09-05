import type {
  DocumentRecord,
  DocumentStatus,
  Evidence,
  EvidenceStatus,
  MatterStatus,
  RiskLevel,
} from "@/lib/domain/types";

const statusLabels: Record<
  MatterStatus | DocumentStatus | EvidenceStatus | RiskLevel,
  string
> = {
  IN_REVIEW: "검토 중",
  READY: "검토 대기",
  NEEDS_INFO: "자료 요청",
  CLOSED: "완료",
  QUARANTINED: "보안 검사 대기",
  SCANNING: "보안 검사",
  PARSING: "내용 처리 중",
  INDEXED: "검색 준비 완료",
  FAILED: "처리 실패",
  PENDING: "근거 검토 대기",
  APPROVED: "근거 사용 승인",
  REJECTED: "근거 사용 제외",
  HIGH: "높음",
  MEDIUM: "보통",
  LOW: "낮음",
};

const dataClassLabels: Record<DocumentRecord["piiClass"], string> = {
  RESTRICTED: "제한",
  CONFIDENTIAL: "기밀",
  INTERNAL: "내부용",
};

const sourceTypeLabels: Record<Evidence["sourceType"], string> = {
  BUSINESS_RECORD: "고객사 자료",
  TAX_AUTHORITY: "세법령·공식 자료",
  INTERNAL_POLICY: "내부 지침",
};

const auditActionLabels: Record<string, string> = {
  AI_CITATION_VERIFIED: "AI 답변 근거 검증",
  AI_DEMO_RUN_CREATED: "AI 시연 분석 시작",
  AI_RUN_COMPLETED: "AI 분석 완료",
  AI_RUN_CREATED: "AI 분석 시작",
  AI_RUN_FAILED: "AI 분석 실패",
  AI_RUN_STALE_RECOVERED: "중단된 AI 분석 복구",
  APPROVED: "승인",
  CROSS_TENANT_READ_DENIED: "다른 조직 자료 접근 차단",
  DOCUMENT_EVIDENCE_APPROVED: "검색 근거 사용 승인",
  DOCUMENT_EVIDENCE_REJECTED: "검색 근거 사용 제외",
  DOCUMENT_UPLOAD_DEDUPLICATED: "중복 문서 확인",
  DOCUMENT_UPLOAD_QUEUED: "문서 처리 등록",
  MATTER_CREATED: "세무 업무 등록",
  MCP_LIST_MATTERS: "MCP 세무 업무 조회",
  MCP_SEARCH_EVIDENCE: "MCP 근거 검색",
  REJECTED: "반려",
  TOOL_CALCULATE_VAT: "부가가치세 계산 도구 실행",
};

const auditOutcomeLabels = {
  SUCCESS: "성공",
  DENIED: "차단",
  FAILED: "실패",
} as const;

const workflowStageLabels: Record<string, string> = {
  INTAKE: "요청 범위 확인",
  RETRIEVE: "근거 검색",
  DRAFT: "분석 초안 작성",
  VERIFY: "독립 검증",
  AWAITING_REVIEW: "전문가 검토 대기",
};

const toolLabels: Record<string, string> = {
  abstain: "답변 보류",
  calculateVat: "부가가치세 계산",
  deliverVerifiedAnswer: "검증 결과 작성",
  independentReview: "독립 검증",
  proposeWorkpaper: "검토조서 초안 저장",
  searchTaxSources: "세무 근거 검색",
  verifyEvidence: "근거 연결 검증",
};

const toolStateLabels: Record<string, string> = {
  "input-streaming": "입력 확인 중",
  "input-available": "실행 중",
  "output-available": "완료",
  "output-error": "실패",
  "output-denied": "실행 거부",
  "approval-requested": "승인 대기",
  "approval-responded": "승인 응답 확인",
};

const reviewVerdictLabels: Record<string, string> = {
  SUPPORTED: "근거 확인 완료",
  NEEDS_REVIEW: "전문가 확인 필요",
  UNSUPPORTED: "근거 부족",
};

export function dataClassLabel(value: DocumentRecord["piiClass"]) {
  return dataClassLabels[value];
}

export function statusLabel(value: keyof typeof statusLabels) {
  return statusLabels[value];
}

export function sourceTypeLabel(value: Evidence["sourceType"]) {
  return sourceTypeLabels[value];
}

export function auditActionLabel(value: string) {
  return auditActionLabels[value] ?? value;
}

export function auditOutcomeLabel(value: keyof typeof auditOutcomeLabels) {
  return auditOutcomeLabels[value];
}

export function workflowStageLabel(value: string) {
  return workflowStageLabels[value] ?? value;
}

export function toolLabel(value: string) {
  return toolLabels[value] ?? value;
}

export function toolStateLabel(value: string) {
  return toolStateLabels[value] ?? value;
}

export function reviewVerdictLabel(value: string) {
  return reviewVerdictLabels[value] ?? value;
}

export function jurisdictionLabel(value: string) {
  return value === "KR" ? "대한민국" : value;
}

export function matchingAuditActions(query: string) {
  const normalized = query.trim().toLocaleLowerCase("ko-KR");
  return Object.entries(auditActionLabels)
    .filter(([key, label]) =>
      `${key} ${label}`.toLocaleLowerCase("ko-KR").includes(normalized),
    )
    .map(([key]) => key);
}
