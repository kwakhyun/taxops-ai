import { createHash } from "node:crypto";
import { evidence as evidenceFixture } from "@/lib/domain/fixtures";
import type { Evidence } from "@/lib/domain/types";

export const RETRIEVER_VERSION = "hybrid-rag.v1.2.0";

function tokens(value: string) {
  return [
    ...new Set(
      value
        .toLocaleLowerCase("ko-KR")
        .split(/[\s,.·()[\]{}:;!?]+/)
        .filter((token) => token.length > 1),
    ),
  ];
}

export function lexicalScore(query: string, item: Evidence) {
  const queryTokens = tokens(query);
  const target =
    `${item.documentName} ${item.section} ${item.excerpt}`.toLocaleLowerCase(
      "ko-KR",
    );
  if (!queryTokens.length) return 0;
  return (
    queryTokens.filter((token) => target.includes(token)).length /
    queryTokens.length
  );
}

export function retrieveEvidence(input: {
  tenantId: string;
  matterId: string;
  query: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 8);
  return (
    evidenceFixture
      .filter(
        (item) =>
          item.tenantId === input.tenantId && item.matterId === input.matterId,
      )
      .map((item) => ({ item, lexical: lexicalScore(input.query, item) }))
      // The local demo has no embedding service. Requiring at least one lexical signal
      // makes the fallback fail closed instead of returning unrelated high-prior fixtures.
      .filter(({ lexical }) => lexical > 0)
      .map(({ item, lexical }) => ({
        ...item,
        score: Number((item.score * 0.65 + lexical * 0.35).toFixed(3)),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  );
}

export interface SupportedClaim {
  text: string;
  evidenceIds: string[];
  claimType: "LEGAL_RULE" | "TRANSACTION_FACT" | "INTERNAL_PROCESS";
}

function hasTaxPolarityConflict(claim: string, evidenceText: string) {
  const negative =
    /(불공제|공제하지|공제되지\s*않|공제할\s*수\s*없|제외(?:한다|된다)|금지(?:한다|된다))/;
  const positive =
    /(공제합니다|공제한다|공제된다|공제됩니다|공제\s*가능|공제할\s*수\s*있)/;
  const opposite = (positivePattern: RegExp, negativePattern: RegExp) =>
    (positivePattern.test(claim) && negativePattern.test(evidenceText)) ||
    (negativePattern.test(claim) && positivePattern.test(evidenceText));
  const differencePositive =
    /(?:\d+(?:\.\d+)?원\s*)?차이(?:가|는|도)?\s*(?:있|발생|확인)/;
  const differenceNegative = /차이(?:가|는|도)?\s*(?:전혀\s*)?없/;
  const relationPositive = /(?:직접\s*)?관련(?:된|이\s*있|성이\s*있)/;
  const relationNegative = /(?:직접\s*)?관련(?:이|성이)?\s*없|관련되지\s*않/;
  const reflectedPositive = /반영(?:되어|되었|됐|한다|합니다)/;
  const reflectedNegative = /반영되지\s*않/;
  const copulaNegative = /아닙니다|아니다|아닌|아니며|아니었/;
  return (
    (positive.test(claim) && negative.test(evidenceText)) ||
    (negative.test(claim) && positive.test(evidenceText)) ||
    opposite(differencePositive, differenceNegative) ||
    opposite(relationPositive, relationNegative) ||
    opposite(reflectedPositive, reflectedNegative) ||
    copulaNegative.test(claim) !== copulaNegative.test(evidenceText)
  );
}

export function verifyClaims(
  claims: SupportedClaim[],
  scopedEvidence: Evidence[],
) {
  const evidenceById = new Map(scopedEvidence.map((item) => [item.id, item]));
  const results = claims.map((claim) => {
    const cited = claim.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is Evidence => Boolean(item));
    const claimText = claim.text.toLocaleLowerCase("ko-KR").replaceAll(",", "");
    const evidenceText = cited
      .map((item) => item.excerpt)
      .join(" ")
      .toLocaleLowerCase("ko-KR")
      .replaceAll(",", "");
    const claimTokens = tokens(claimText);
    const matchingTokens = claimTokens.filter((token) =>
      evidenceText.includes(token),
    );
    const claimNumbers = claimText.match(/\d+(?:\.\d+)?/g) ?? [];
    const numbersMatch = claimNumbers.every((number) =>
      evidenceText.includes(number),
    );
    const requiredMatches = Math.min(2, claimTokens.length);
    const sourceTierSupported =
      claim.claimType === "LEGAL_RULE"
        ? cited.some((item) => item.sourceType === "TAX_AUTHORITY")
        : claim.claimType === "INTERNAL_PROCESS"
          ? cited.some((item) => item.sourceType === "INTERNAL_POLICY")
          : cited.some((item) => item.sourceType === "BUSINESS_RECORD");
    const semanticMatch =
      claimTokens.length > 0 &&
      matchingTokens.length >= requiredMatches &&
      numbersMatch &&
      !hasTaxPolarityConflict(claimText, evidenceText);
    return {
      claim: claim.text,
      evidenceIds: claim.evidenceIds,
      claimType: claim.claimType,
      sourceTierSupported,
      supportScore: claimTokens.length
        ? Number((matchingTokens.length / claimTokens.length).toFixed(3))
        : 0,
      supported:
        cited.length > 0 &&
        cited.length === claim.evidenceIds.length &&
        sourceTierSupported &&
        semanticMatch,
    };
  });
  const supportedClaims = results.filter((result) => result.supported).length;
  return {
    results,
    supportedClaims,
    totalClaims: claims.length,
    coverage: claims.length
      ? Math.round((supportedClaims / claims.length) * 100)
      : 0,
  };
}

export function verifyCitationExcerpt(
  evidenceId: string,
  excerpt: string,
  scopedEvidence: Evidence[],
) {
  const source = scopedEvidence.find((item) => item.id === evidenceId);
  if (!source) return false;
  const normalizedSource = source.excerpt.replace(/\s+/g, " ").trim();
  const normalizedExcerpt = excerpt.replace(/\s+/g, " ").trim();
  return (
    normalizedExcerpt.length >= 8 &&
    normalizedSource.includes(normalizedExcerpt)
  );
}

export function queryHash(query: string) {
  return createHash("sha256").update(query).digest("hex");
}
