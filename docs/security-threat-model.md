# 보안 위협 모델

## 보호 대상과 신뢰 경계

보호 대상은 고객 원본 문서, 추출 텍스트와 임베딩, 세무 결론, 승인 기록, 사용자 신원, 감사 로그, API·OIDC·문서 처리 secret입니다. 브라우저, 공개 ALB, 웹 런타임, 작업 큐, 워커, 데이터베이스, 객체 저장소, AI Gateway, 문서 처리 서비스 사이를 각각 별도 신뢰 경계로 봅니다.

## 주요 위협과 통제

| 위협                         | 통제                                                                                                             | 검증                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 위조된 사용자·역할           | Code + PKCE·state·nonce, issuer/audience/algorithm 고정, HttpOnly 세션, DB membership 재확인, 역할 claim 불신    | 인증 단위 테스트, production demo-auth 차단 |
| 교차 테넌트 접근             | API 소속 검사, repository tenant filter, 복합 FK, PostgreSQL RLS, 별도 app/worker 역할                           | tenant isolation 테스트, CI RLS 계약 테스트 |
| 악성·위장 파일               | 허용 목록, 크기 제한, 정규화 파일명, MIME/확장자/magic bytes 일치, SHA-256, quarantine, ClamAV                   | 파일 검증 테스트와 E2E 거부 흐름            |
| 검역 전·미승인 근거 검색     | `INDEXED`, `APPROVED`, `SAFE`, current chunk와 과세기간 효력을 모두 만족하는 근거만 검색                         | retrieval 테스트, 실제 PostgreSQL 계약      |
| prompt injection·도구 오용   | 질문 guardrail, 문서 필드의 인증된 의미 분류, fail-closed 정책, 제한된 단계, 고정 tool schema와 stream allowlist | 직접·간접 injection과 위조 stream 테스트    |
| 근거 없는 세무 결론          | exact citation 검사, 독립 verifier, 기권 경로, 승인 전 초안 상태                                                 | golden set 평가, 인용 E2E                   |
| 승인 위조·재사용             | 독립 Reviewer OIDC resource, 암호화 봉투, HMAC 토큰, reviewer/action/artifact hash 바인딩, 원자적 DB 전이        | 토큰 변조·잘못된 행위·재사용 HTTP 계약      |
| 감사 기록 변조               | 테넌트별 advisory lock, 이전 해시 연결, DB update/delete 차단, 전체 체인 DB 재계산                               | 해시 단위 테스트, PostgreSQL 전체 체인 계약 |
| 로그·AI 반출을 통한 PII 유출 | allowlist 로그, 패턴 redaction, 원문·토큰 비기록 telemetry, tenant 반출 정책과 provider 처리 지역 검증           | redaction·AI 정책 테스트와 코드 검토        |
| MCP DNS rebinding·권한 확대  | Host/Origin allowlist, 기존 OIDC/RBAC 재사용, read-only tool annotation, raw token 미보관                        | 공식 MCP 클라이언트 E2E                     |
| 비용·지연 폭주               | PostgreSQL 공유 rate limit, 월간 원자적 예산 예약, 8-step·token·cost 상한, timeout과 retry 제한                  | budget 테스트와 평가 report                 |

## 운영 전 필수 보강

- 조직 IdP에 redirect URI와 PKCE client를 등록하고 access token·서명 세션 수명 정책 확정
- KMS key policy, VPC endpoint, S3 bucket policy, egress allowlist 검토
- PostgreSQL 공유 rate limit bucket의 보존 기간과 정리 작업 확정
- 악성 파일 샘플, zip bomb, parser 취약점, SSRF를 포함한 침투 시험
- PII 분류·마스킹, 보존·파기, 법적 hold 정책과 개인정보 영향평가
- 감사 로그 외부 불변 저장소 전송과 탐지 규칙 구성
- 공식 법령·예규 connector가 발행기관 서명 또는 승인된 digest를 검증하도록 구성
- 실제 의미 분류기 endpoint에서 한국어·영어 paraphrase, 인코딩, 간접 지시, 정상 문서 오탐과 p95 지연을 측정하고 승인된 modelVersion을 고정
- 의존성 SBOM, 이미지 서명, secret scan, SAST/DAST를 조직 CI에 연결

로컬 데모는 프로세스 메모리 rate limiter를 사용하지만, `DATABASE_URL`이 있는 다중 인스턴스 환경에서는 PostgreSQL의 원자적 bucket과 승인 행 상태 전이를 사용합니다.

DB 감사 체인은 전체 이벤트를 다시 해시해 누락과 변조를 탐지하지만 DB 소유자와 독립된 불변 증거는 아닙니다. production에서는 주기적으로 head hash와 건수를 서명해 Object Lock 또는 조직 SIEM의 WORM 저장소에 보관해야 합니다. `TAXOPS_LOCAL_STACK=true`는 의미 분류기와 일부 외부 서비스를 로컬 대체 경로로 실행하기 위한 시험 전용 설정이며 production task definition에는 주입하지 않습니다.

`npm audit --omit=dev` 기준 production 의존성은 알려진 취약점 0건입니다. 전체 감사에는 현재 `drizzle-kit`이 중첩 참조하는 개발 서버용 구버전 `esbuild` 때문에 moderate 권고 4건이 남습니다. 감사 도구가 제시하는 해결책은 Drizzle을 호환되지 않는 구버전으로 내리는 것이므로 적용하지 않았습니다. migration CLI는 CI·개발 환경에서만 실행하고 네트워크에 노출하지 않으며, 상위 패키지의 수정 릴리스를 추적해야 합니다.
