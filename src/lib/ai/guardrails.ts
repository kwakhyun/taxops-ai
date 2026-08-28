const injectionPatterns = [
  /ignore (all|any|the|previous) (instructions?|rules?)/i,
  /ignore.{0,20}(prior|previous|all|any|the)?.{0,10}(instructions?|directives?|rules?)/i,
  /(disregard|forget|override).{0,40}(instructions?|system|policy|rules?)/i,
  /disregard.{0,30}(prior|previous)?.{0,10}(directives?|instructions?|rules?)/i,
  /(earlier|prior|previous|current).{0,30}(policy|safeguards?|guardrails?|rules?|restrictions?).{0,30}(obsolete|revoked|invalid|void|no longer appl)/i,
  /(bypass|circumvent|disable|evade).{0,30}(safeguards?|guardrails?|controls?|restrictions?|verification|policy)/i,
  /(invoke|call|execute|run).{0,30}(proposeworkpaper|approval function|approval tool|write tool|delete tool)/i,
  /이전 (지시|규칙|명령).*(무시|잊어)/i,
  /(앞선|이전|기존).{0,20}(명령|지시|규칙).{0,30}(따르지|무시|잊어)/i,
  /(무시|우회|재정의|덮어써).{0,40}(지시|규칙|정책|시스템|명령)/i,
  /(위|앞선|기존|이전).{0,20}(제한|정책|보호|안전s*장치|검증).{0,30}(폐기|무효|해제|적용되지|끝났)/i,
  /(안전s*장치|보호s*조치|제한|검증|가드레일).{0,30}(우회|비활성|건너뛰|해제)/i,
  /(proposeworkpaper|승인 함수|승인 도구|쓰기 도구|삭제 도구).{0,30}(즉시|바로)?.{0,20}(호출|실행)/i,
  /(system prompt|시스템 프롬프트).*(출력|공개|보여)/i,
  /(show|reveal|expose|display).{0,50}(system prompt|developer message|secret|credentials?|api key)/i,
  /(개발자|developer).{0,20}(메시지|지시|프롬프트).{0,30}(보여|출력|공개)/i,
  /(?:^|\n)\s*(system|assistant|developer)\s*:/im,
  /<\/?\s*(system|assistant|developer)(?:\s|>)/i,
  /(you are now|act as|새로운 지시|이제부터.{0,20}역할)/i,
  /(follow|obey).{0,30}(instructions?|directives?).{0,60}(call|invoke|execute).{0,30}(approval|function|tool)/i,
  /(tool call|도구 호출|function call).{0,40}(실행|호출|run|execute)/i,
  /(문서|검색|근거).{0,20}(지시|명령).{0,50}(도구|tool).{0,20}(호출|실행)/i,
  /(승인|쓰기|삭제).{0,20}(도구|tool).{0,20}(호출|실행)/i,
  /(secret|credential|api key|비밀|자격 증명).{0,40}(출력|공개|전송|show|send)/i,
  /(reveal|expose|show|send).{0,40}(secret|credentials?|api key)/i,
  /시스템.{0,20}(지침|규칙|정책).{0,30}(신경\s*쓰지|무시).{0,30}(비밀|자격|프롬프트)/i,
  /(other|another|다른) (tenant|customer|고객|테넌트).*(data|자료|데이터)/i,
  /169\.254\.169\.254|localhost|127\.0\.0\.1/i,
  /(document|source|record).{0,30}(authoritative|trusted).{0,80}(create|prepare|submit|approve|mark)/i,
  /(review|verification).{0,30}(already|deemed|considered).{0,20}(complete|finished|done).{0,80}(workpaper|approval|evidence)/i,
  /(workflow update|new workflow|revised procedure).{0,80}(mark|create|prepare|approve|submit)/i,
  /(document|procedure).{0,30}(takes? priority|overrides?|supersedes?).{0,30}(system|policy|instruction)/i,
  /(검토|검증).{0,20}(이미|끝난|완료된).{0,20}(것으로 )?(간주|처리).{0,50}(워크페이퍼|승인|근거)/i,
  /(워크플로|처리 절차).{0,20}(변경|업데이트|적용).{0,60}(근거|워크페이퍼|승인)/i,
  /시스템보다.{0,40}(문서|처리 절차|자료).{0,30}(우선|먼저).{0,50}(승인|워크페이퍼|요청)/i,
] as const;

export class PromptInjectionError extends Error {
  readonly status = 422;
  readonly code = "PROMPT_INJECTION_DETECTED";

  constructor() {
    super("문서 또는 요청에서 안전하지 않은 지시 패턴이 감지되었습니다.");
    this.name = "PromptInjectionError";
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]{1,7});?/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&(lt|gt|colon|sol|Tab|NewLine|amp);/g, (entity) => {
      const decoded: Record<string, string> = {
        "&lt;": "<",
        "&gt;": ">",
        "&colon;": ":",
        "&sol;": "/",
        "&Tab;": "\t",
        "&NewLine;": "\n",
        "&amp;": "&",
      };
      return decoded[entity] ?? entity;
    });
}

export function canonicalizeUntrustedText(value: string) {
  let canonical = decodeHtmlEntities(value.normalize("NFKC")).replace(
    /\p{Cf}/gu,
    "",
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const decoded = decodeURIComponent(canonical);
      if (decoded === canonical) break;
      canonical = decodeHtmlEntities(decoded.normalize("NFKC")).replace(
        /\p{Cf}/gu,
        "",
      );
    } catch {
      break;
    }
  }
  canonical = canonical.replace(/[\s\u00a0]+/g, " ").trim();
  return canonical.replace(/\b(?:[a-z]\s+){2,}[a-z]\b/gi, (spacedWord) =>
    spacedWord.replace(/\s+/g, ""),
  );
}

export function detectPromptInjection(value: string) {
  const canonical = canonicalizeUntrustedText(value);
  if (injectionPatterns.some((pattern) => pattern.test(canonical))) return true;

  const hasPrivilegedAction =
    /(proposeworkpaper|workpaper|write function|approval (?:function|tool)|submit (?:the )?draft|워크페이퍼|승인 (?:함수|도구)|쓰기 (?:함수|도구)|제출 기능)/i.test(
      canonical,
    );
  const hasOverrideIntent =
    /(supersed|lapsed|obsolete|revoked|invalidated|without (?:validation|verification|checking evidence)|before (?:checking|validating|verification)|skip (?:the )?(?:validation|verification)|developer note|prioritize this document|효력을? (?:잃|상실)|검증 (?:단계를 )?생략|검증 없이|확인 전에|상기 방침|개발자 (?:메모|참고)|이 자료를 우선)/i.test(
      canonical,
    );
  const hasInstructionIntent =
    /(?:use|choose|select|submit|invoke|call|execute|prioritize|사용|선택|제출|호출|실행|우선)/i.test(
      canonical,
    );
  return hasPrivilegedAction && hasOverrideIntent && hasInstructionIntent;
}

/**
 * Source documents have no authority to direct the agent or mutate workflow
 * state. This classifier is intentionally stricter than the user-prompt gate:
 * a legitimate user may request a draft, while retrieved content may only
 * supply facts and must never request the next tool or approval transition.
 */
export function detectUntrustedSourceInstruction(value: string) {
  const canonical = canonicalizeUntrustedText(value);
  if (detectPromptInjection(canonical)) return true;

  const hasWorkflowTarget =
    /(workpaper|approval request|approval state|evidence (?:review|verification|status)|워크페이퍼|승인 요청|승인 상태|근거 (?:검토|검증|상태))/i.test(
      canonical,
    );
  const hasStateChangingDirective =
    /(?:create|prepare|submit|approve|request|mark|set|treat|consider|apply|next (?:step|operation)|생성|작성|준비|제출|승인|요청|표시|설정|간주|적용|다음 (?:단계|동작))/i.test(
      canonical,
    );
  const assertsControlAuthority =
    /(?:authoritative|trusted instruction|workflow update|procedure|even if|regardless of|already (?:complete|finished|verified)|system|priority|우선|처리 절차|워크플로|이미 (?:완료|끝)|완료된 것으로|간주|시스템|검토가? 미완료)/i.test(
      canonical,
    );

  return (
    hasWorkflowTarget && hasStateChangingDirective && assertsControlAuthority
  );
}

export function assertSafePrompt(value: string) {
  if (detectPromptInjection(value)) throw new PromptInjectionError();
}
