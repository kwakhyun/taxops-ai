# 요구사항 추적표

이 표는 구현 근거와 아직 저장소만으로 증명할 수 없는 항목을 구분합니다. “구현”은 코드와 자동 검증이 있다는 뜻이며, 실제 운영 경력이나 고객 배포를 의미하지 않습니다.

| 역량 영역                        | 구현 근거                                                                               | 자동 검증                                                       | 상태                      |
| -------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| React/Next.js/TypeScript 제품 UI | `src/app`, `src/components`, App Router, Server/Client Component 분리, 반응형 업무 화면 | typecheck, build, Chromium E2E, 모바일 시각 점검                | 구현                      |
| REST와 서버 로직                 | `src/app/api/v1`, Zod 계약, 오류 envelope, request ID                                   | API 포함 E2E, 단위 테스트                                       | 구현                      |
| 외부 서비스 연동                 | OIDC/JWKS, S3, ClamAV, private processor, AI Gateway, MCP, 서명 webhook                 | 로컬 대체 경로와 계약 테스트, 실제 production endpoint는 미연결 | 구현, 실환경 검증 필요    |
| DB 설계·쿼리·migration           | 18개 테이블·enum, pgvector/FTS, 복합 FK·index, Drizzle schema와 SQL migration           | PostgreSQL migration/seed, RLS·역할·승인 경계 25건              | 구현                      |
| 인증·권한                        | OIDC Code + PKCE와 Bearer 검증, DB membership role, RBAC, RLS, Origin 검증              | 역할·tenant 단위 테스트, RLS CI                                 | 구현                      |
| 파일 처리                        | 형식/서명/크기/checksum, OOXML ZIP 구조, quarantine, ClamAV, parse, chunk, index        | 파일 단위 테스트, EICAR 포함 Worker 컨테이너 스모크             | 구현                      |
| 비동기 작업                      | DB queue, idempotency, lease, heartbeat, retry/jitter, DLQ, outbox                      | 상태·업로드 테스트, DB 계약 job                                 | 구현                      |
| 운영 로그·감사                   | allowlist JSON log, redaction, trace/request ID, 전체 테넌트 hash-chain verifier        | redaction·hash 단위 테스트, PostgreSQL 전체 체인 계약           | 구현, 외부 WORM 연동 필요 |
| Docker·CI/CD·cloud               | multi-stage web/worker image, Compose, GitHub Actions, AWS ECS/RDS/S3/KMS Terraform     | image build CI, compose config; Terraform apply는 미실행        | 구현, 계정 적용 필요      |
| 생성형 AI 서비스                 | streaming AI route, hybrid RAG, tool calling, 독립 verifier, 기권                       | 45-case eval, 5개 mock agent 실행, AI E2E                       | 구현, 실제 모델 평가 필요 |
| MCP·agent orchestration          | 공식 MCP SDK read-only server, ToolLoopAgent 2단계 검증                                 | 공식 MCP client E2E, tool 정책 테스트                           | 구현                      |
| 프롬프트 자산화                  | versioned prompt, tool schema, retrieval version, report provenance                     | eval report에 버전 기록                                         | 구현                      |
| 품질·latency·cost·observability  | 품질 gate, step/time/token/cost budget, 월간 원자적 예산 예약, telemetry 원문 비기록    | budget 단위 테스트, eval                                        | 구현                      |
| 민감정보와 enterprise control    | PII redaction, OIDC, RBAC, tenant RLS, KMS/S3, 분리 승인 서비스, audit                  | 보안 테스트, Reviewer OIDC/HTTP 계약, threat model              | 구현, 조직 통제 연동 필요 |
| 파일 중심 업무 UX                | 세무 업무→업로드→AI 근거→검토 승인→감사 흐름                                            | 9개 end-to-end 시나리오                                         | 구현                      |
| 모호한 요구의 기술 분해          | 요구사항, architecture, threat model, quality gate, runbook으로 분리                    | 문서와 코드 traceability                                        | 구현                      |
| 실제 사용자 배포·운영 3년 이상   | 저장소로는 재직 기간과 실사용 운영 이력을 입증할 수 없음                                | 경력증명, 실제 서비스 지표, 추천서 등 별도 자료 필요            | 미증명                    |

## 대표 사용자 시나리오

1. 세무 실무자가 업무를 만들고 세무 검토자를 지정합니다.
2. 위장 파일은 즉시 거부되고 유효한 자료는 격리 저장소와 내구성 작업 큐로 이동합니다.
3. 워커가 검사와 인덱싱을 완료하고 세무 검토자가 AI 근거 사용을 승인한 자료만 검색 대상이 됩니다.
4. AI는 현재 조직과 세무 업무 안에서 근거를 찾고, 계산 도구를 사용해 초안을 만듭니다.
5. 별도 검증 에이전트가 인용과 주장을 확인합니다. 근거가 없으면 답변을 보류합니다.
6. 세무 검토자는 산출물 해시에 묶인 일회성 토큰으로 승인하거나 반려합니다.
7. 모든 중요 동작은 해시 체인 감사 이벤트로 남습니다.

## 검증 범위의 한계

2026-08-30 로컬 검증에서는 PostgreSQL/pgvector 마이그레이션과 RLS·역할·승인 경계 계약 25건을 통과했습니다. 분리된 검토 서비스의 OIDC/HTTP 계약과 MinIO·ClamAV 워커 스모크 테스트도 컨테이너에서 확인했습니다.

검증에는 근거 0건, 위조된 원문 필드, 앱 역할의 검토조서 이력 직접 쓰기를 거부하는 시나리오가 포함됩니다. 정상 승인과 연결된 AI 실행 상태가 함께 전이되는지도 확인합니다. 이는 로컬 통합 검증이며 AWS 계정에 Terraform을 적용했거나 실제 IdP, 개인정보 비식별화, 의미 분류기, 문서 처리기와 연결했다는 의미는 아닙니다.
