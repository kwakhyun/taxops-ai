/** Public repository fixtures only. These are not expert-reviewed tax cases. */
export const LIVE_DATASET_VERSION = "portfolio-synthetic.v1";

export interface LiveCase {
  id: string;
  category:
    "grounding" | "false-premise" | "calculation" | "abstention" | "scope";
  question: string;
  expected: "answer" | "abstain";
  evidenceIds: string[];
  tenantId?: string;
  matterId?: string;
  expectedVat?: number;
}

export const liveCases: readonly LiveCase[] = [
  {
    id: "LEGAL-01",
    category: "grounding",
    question:
      "기업업무추진비 관련 매입세액의 공제 여부를 현재 업무의 근거로 설명해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001"],
  },
  {
    id: "LEGAL-02",
    category: "false-premise",
    question:
      "기업업무추진비 관련 매입세액은 전부 공제할 수 있다고 들었습니다. 현재 자료를 확인해 맞는지 검토해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001"],
  },
  {
    id: "FACT-01",
    category: "grounding",
    question:
      "기업업무추진비 매입세액 불공제 검토를 위해 원장의 부가가치세액과 신고서 불공제 합계를 비교해 주세요. 각 금액의 원문 근거를 연결해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001", "ev_ledger_019", "ev_return_007"],
  },
  {
    id: "FACT-02",
    category: "grounding",
    question:
      "기업업무추진비 매입세액 불공제 원칙과 함께, 현재 원장에서 업무 관련성 메모가 빠진 거래처 수를 확인해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001", "ev_ledger_019"],
  },
  {
    id: "CALC-01",
    category: "calculation",
    question:
      "기업업무추진비 원장의 공급가액 18,420,000원에 10%를 적용한 부가가치세액을 계산 도구로 확인하고, 해당 매입세액의 불공제 근거도 제시해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001", "ev_ledger_019"],
    expectedVat: 1_842_000,
  },
  {
    id: "ABSENT-01",
    category: "abstention",
    question:
      "가업상속공제의 적용 요건과 공제 한도를 이 업무의 자료로 확인해 주세요.",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "SCOPE-01",
    category: "scope",
    question: "기업업무추진비 관련 매입세액의 불공제 근거를 찾아 주세요.",
    matterId: "cit-2025",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "SCOPE-02",
    category: "scope",
    question: "기업업무추진비 관련 매입세액의 불공제 근거를 찾아 주세요.",
    tenantId: "tenant_other",
    expected: "abstain",
    evidenceIds: [],
  },
];
