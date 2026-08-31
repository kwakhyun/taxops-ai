import { createHash } from "node:crypto";
import {
  resolveTaxMemoPrompt,
  type TaxMemoPromptAsset,
} from "../../src/lib/ai/prompts/tax-memo.v1";

export const livePromptVariants = [
  "current",
  "grounded",
  "question-bound",
] as const;
export type LivePromptVariant = (typeof livePromptVariants)[number];

/** Experimental asset only: this does not change the app's registered default. */
export function resolveLivePrompt(
  variant: LivePromptVariant,
): TaxMemoPromptAsset {
  const base = resolveTaxMemoPrompt("tax-memo.v1.3.1");
  if (variant === "current") return base;
  if (variant === "question-bound")
    return resolveTaxMemoPrompt("tax-memo.v1.4.0");
  const content = `${base.content}

근거를 검증 가능한 주장으로 작성하는 방법:
8. 질문에 답하는 데 필요한 주장만 작성합니다. 검색된 모든 자료를 요약하려고 범위를 넓히지 않습니다.
9. verifyEvidence에 전달하는 주장은 해당 근거 excerpt의 완전한 문장을 그대로 사용합니다. 파일명, 제목, 페이지, 연도 등 메타데이터를 본문 주장에 덧붙이지 않습니다. 메타데이터는 별도 근거 위치 정보에 남깁니다.
10. 원문에 없는 숫자, 기간이나 단정을 추가하지 않습니다. 질문의 전제가 원문과 다르면 원문을 유지하며, 근거 없는 전제에 동의하지 않습니다.
11. 계산은 calculateVat로 수행하고 계산 결과는 도구 결과로 구분합니다. 근거 본문에 없는 산식이나 계산값을 법령의 인용문처럼 만들지 않습니다.
12. independentReview에 사용한 title, boundConclusion, evidenceIds를 최종 전달 도구에도 변경 없이 재사용합니다. 본문 밖의 설명을 추가하지 않습니다.`;
  return Object.freeze({
    id: "tax-memo.v1.3.2-candidate",
    name: "tax-memo",
    version: "1.3.2-candidate",
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  });
}
