# API와 MCP 계약

모든 REST 응답은 `x-request-id`를 돌려주며 오류는 `{ error: { code, message }, meta: { requestId } }` 형태를 사용합니다. 운영 환경의 브라우저는 OIDC Authorization Code + PKCE로 서명된 HttpOnly 세션을 받습니다. 세션 `jti`는 DB 활성 상태와 매 요청 대조하며 로그아웃 시 즉시 폐기합니다. API와 MCP 클라이언트는 OIDC Bearer 토큰을 사용합니다.

토큰의 역할과 조직 소속 클레임을 그대로 신뢰하지 않고 DB에서 다시 확인합니다. 쿠키 기반 쓰기 요청은 등록된 `APP_BASE_URL` Origin만 허용합니다.

## REST API

| HTTP 메서드 | 경로                             | 권한               | 설명                                                                     |
| ----------- | -------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| GET         | `/api/health/live`               | 없음               | 프로세스 생존 상태                                                       |
| GET         | `/api/health/ready`              | 없음               | 준비 상태만 반환. 운영 전용 Bearer 토큰을 보내면 의존 서비스별 진단 포함 |
| GET         | `/api/v1/cases/export`           | `case:read`        | 현재 조직의 세무 업무 목록을 CSV로 내려받기                              |
| GET         | `/api/v1/cases`                  | `case:read`        | 현재 조직의 세무 업무 목록, 검색과 페이지 조회                           |
| POST        | `/api/v1/cases`                  | `case:write`       | 세무 업무 생성                                                           |
| POST        | `/api/v1/uploads`                | `document:upload`  | 검증 후 격리 저장하고 비동기 작업을 큐에 등록                            |
| GET         | `/api/v1/documents/:id/download` | `document:read`    | 현재 조직에서 색인 완료되고 객체 체크섬이 확인된 원본 자료 내려받기      |
| GET         | `/api/v1/documents/:id/evidence` | `workpaper:review` | 담당 세무 검토자용 추출 내용과 전체 체크섬 조회                          |
| PATCH       | `/api/v1/documents/:id/evidence` | `workpaper:review` | 체크섬에 고정해 AI 근거로 승인 또는 제외                                 |
| GET         | `/api/v1/jobs/:id`               | `document:read`    | 현재 조직의 작업 상태 조회                                               |
| POST        | `/api/v1/assistant`              | `assistant:run`    | 세무 업무 범위에서 AI 스트림 실행                                        |
| GET         | `/api/v1/reviews/:id`            | `workpaper:review` | 검토 대상과 산출물 해시에 연결된 승인 토큰 조회                          |
| POST        | `/api/v1/reviews/:id`            | `workpaper:review` | 승인 또는 반려, 토큰 일회성 소비                                         |
| GET         | `/api/v1/audit`                  | `audit:read`       | 전체 감사 이력 검색, 페이지 조회와 CSV 내보내기                          |

`GET /api/v1/cases/search`는 `case:read` 권한으로 고객사, 세목, 기간, 요약을 검색하고 이동에 필요한 필드만 최대 9건 반환합니다. `q`는 최대 200자입니다. 문서 본문 검색은 포함하지 않습니다.

업로드 요청은 multipart `file`, `matterId`와 `Idempotency-Key` 헤더를 요구합니다. AI 요청은 메시지 배열과 `matterId`를 받으며, 서버가 사용자의 세무 업무 접근 권한을 다시 확인합니다. AI 실행은 월간 예산에서 최대 실행 비용을 원자적으로 예약한 뒤 완료 시 실제 추정치로 정산합니다.

## 목록 조회와 지표

`GET /api/v1/cases`와 `GET /api/v1/audit`의 `data`는 배열이고 `meta`에 `requestId`, `total`, `page`, `pageSize`가 포함됩니다. 기본 페이지는 1, 크기는 25이며 `pageSize`는 1~~100, `page`는 1~~100,000, `q`는 최대 200자입니다. 이전처럼 한 번의 요청으로 전체 목록을 받는 클라이언트는 페이지를 순회해야 합니다. 모든 조회는 현재 조직과 권한 범위로 제한됩니다.

- 세무 업무: `q`, `risk=ALL|HIGH|MEDIUM|LOW`, `page`, `pageSize`. 최근 수정일과 ID 내림차순으로 조회합니다. `/cases/export`는 기존처럼 조직의 전체 업무를 내보냅니다.
- 감사 로그: `q`, `outcome=ALL|SUCCESS|DENIED|FAILED`, `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, `page`, `pageSize`. 행위자 이름, 작업 코드와 한국어 표시명, 대상 ID, 추적 ID를 전체 이력에서 검색합니다. 날짜는 한국 시간 기준이며 양쪽 날짜를 포함합니다. 시각과 ID 내림차순입니다.
- 감사 CSV: 같은 조건에 `format=csv`를 붙이면 현재 페이지와 무관하게 검색 결과 전체를 내보냅니다. 10,000건을 넘으면 잘라내지 않고 `422 EXPORT_TOO_LARGE`를 반환합니다. 날짜 또는 검색 조건을 좁혀 다시 요청합니다. CSV 수식 입력은 이스케이프합니다.

`Matter.evidenceCoverage`는 기존 필드명을 유지하되 **등록 자료 중 색인 완료와 근거 사용 승인을 모두 충족한 비율**을 뜻합니다. 필수 서류 충족률이나 AI 답변 정확도가 아닙니다. `Matter.openFindings`는 평가하지 않은 경우 `null`이며 CSV에는 `미평가`로 표시합니다. `AgentRun.evidenceCoverage`는 별도로 해당 분석의 근거 검증 비율을 나타냅니다.

## AI 메시지와 업로드 상태

현재 서버는 메시지 배열에서 마지막 사용자 질문만 실행합니다. 웹 클라이언트도 마지막 사용자 메시지 한 건만 전송해 대화가 길어져도 배열 상한(30건)에 걸리지 않습니다. 재생성도 같은 질문 한 건을 전송합니다. 이전 대화는 화면에 남지만 모델의 대화 문맥으로 전달되지 않으므로 후속 질문에 필요한 조건은 질문에 명시해야 합니다.

`GET /api/v1/jobs/:id`는 `data`의 작업 상태와 `meta.processingAvailable`을 반환합니다. 업로드 화면은 3초 간격으로 상태를 확인하고 완료 또는 실패 시 자료 목록을 갱신합니다. 조회 오류 또는 2분 경과 시 수동 재확인을 제공합니다. 데모 모드에서는 `processingAvailable=false`를 반환하고 대기열 등록까지만 진행된다고 표시합니다. 창을 닫거나 화면을 이동하면 해당 화면의 상태 조회가 중단됩니다.

## MCP

`/mcp`는 스트리밍 가능한 HTTP MCP 엔드포인트입니다. 공식 TypeScript SDK 서버를 사용하며 상태 비저장 호출을 지원합니다.

| Tool                     | 성격      | 설명                                          |
| ------------------------ | --------- | --------------------------------------------- |
| `list_tax_matters`       | 읽기 전용 | 인증 사용자가 볼 수 있는 세무 업무 목록       |
| `search_matter_evidence` | 읽기 전용 | 지정 세무 업무에서 승인된 현재 버전 근거 검색 |

MCP는 REST와 동일한 OIDC, DB 소속 확인, RBAC, 조직 범위, 요청 제한, 프롬프트 안전 통제와 감사 로그를 재사용합니다. 운영 환경에서는 `MCP_ALLOWED_HOSTS`와 `MCP_ALLOWED_ORIGINS`가 없으면 준비 상태 검사가 실패합니다. 원본 Bearer 토큰은 서버 상태나 로그에 저장하지 않습니다.

쓰기 도구는 MCP에 노출하지 않았습니다. 향후 추가할 경우 사용자 의도 확인, 사전 실행 결과, 산출물 해시에 묶인 승인 토큰과 감사 이벤트를 모두 요구해야 합니다.
