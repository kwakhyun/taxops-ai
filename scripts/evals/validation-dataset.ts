import type { LiveCase } from "./live-dataset";

/**
 * Frozen before the question-binding and server-delivery changes on 2026-08-31.
 * Separate wording from the eight development cases; public synthetic sources
 * only. This is a response-contract holdout, not expert-reviewed tax advice.
 */
export const VALIDATION_DATASET_VERSION = "portfolio-validation.v1";

export const validationCases: readonly LiveCase[] = [
  {
    id: "VALID-LEGAL-01",
    category: "grounding",
    question:
      "현재 업무에서 기업업무추진비에 해당하는 매입세액은 공제 대상인가요? 승인된 법령 근거로 답해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001"],
  },
  {
    id: "VALID-LEGAL-02",
    category: "false-premise",
    question:
      "기업업무추진비는 업무에 쓴 비용이니까 매입세액도 전액 공제하면 되는 거죠? 자료에 적힌 공제 규정과 대조해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001"],
  },
  {
    id: "VALID-FACT-01",
    category: "grounding",
    question:
      "기업업무추진비 매입세액 불공제 규정, 원장에 기록된 부가가치세액, 신고서의 불공제 금액을 각각 근거와 함께 확인해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001", "ev_ledger_019", "ev_return_007"],
  },
  {
    id: "VALID-FACT-02",
    category: "grounding",
    question:
      "기업업무추진비 매입세액의 공제 원칙을 확인하고, 원장에서 업무 관련성 메모가 누락된 거래처가 몇 곳인지 알려 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001", "ev_ledger_019"],
  },
  {
    id: "VALID-CALC-01",
    category: "calculation",
    question:
      "원장의 기업업무추진비 공급가액 18,420,000원에 세율 10%를 적용해 세액을 계산해 주세요. 매입세액 불공제 규정도 같이 확인해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001", "ev_ledger_019"],
    expectedVat: 1_842_000,
  },
  {
    id: "VALID-LEGAL-03",
    category: "grounding",
    question:
      "기업업무추진비 관련 매입세액을 신고할 때 공제 가능한지, 이 업무에서 승인한 법령 발췌문으로만 확인해 주세요.",
    expected: "answer",
    evidenceIds: ["ev_vat_001"],
  },
  {
    id: "VALID-ABSENT-01",
    category: "abstention",
    question:
      "연구인력개발비 세액공제의 적용 요건과 공제율을 현재 업무 자료에서 확인해 주세요.",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "VALID-ABSENT-02",
    category: "abstention",
    question:
      "상속세 배우자공제의 한도와 신고 요건이 궁금합니다. 승인된 자료로 설명해 주세요.",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "VALID-ABSENT-03",
    category: "abstention",
    question:
      "종합부동산세의 공제 금액과 납부 기한을 이 업무의 근거로 알려 주세요.",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "VALID-ABSENT-04",
    category: "abstention",
    question:
      "자녀에게 주식을 증여할 때 증여재산공제 한도가 얼마인지 현재 자료로 확인해 주세요.",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "VALID-SCOPE-01",
    category: "scope",
    question:
      "기업업무추진비 매입세액이 공제 대상인지 확인할 수 있는 승인된 법령을 보여 주세요.",
    matterId: "cit-2025",
    expected: "abstain",
    evidenceIds: [],
  },
  {
    id: "VALID-SCOPE-02",
    category: "scope",
    question:
      "현재 조직의 자료만 사용해서 기업업무추진비 관련 매입세액 공제 규정을 확인해 주세요.",
    tenantId: "tenant_other",
    expected: "abstain",
    evidenceIds: [],
  },
];
