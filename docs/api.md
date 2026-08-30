# API와 MCP 계약

모든 REST 응답은 `x-request-id`를 돌려주며 오류는 `{ error: { code, message }, meta: { requestId } }` 형태를 사용합니다. 운영 환경의 브라우저는 OIDC Authorization Code + PKCE로 서명된 HttpOnly 세션을 받고, API와 MCP 클라이언트는 OIDC Bearer 토큰을 사용합니다.

토큰의 역할과 조직 소속 클레임을 그대로 신뢰하지 않고 DB에서 다시 확인합니다. 쿠키 기반 쓰기 요청은 등록된 `APP_BASE_URL` Origin만 허용합니다.

## REST API

| HTTP 메서드 | 경로                             | 권한               | 설명                                                                     |
| ----------- | -------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| GET         | `/api/health/live`               | 없음               | 프로세스 생존 상태                                                       |
| GET         | `/api/health/ready`              | 없음               | 준비 상태만 반환. 운영 전용 Bearer 토큰을 보내면 의존 서비스별 진단 포함 |
| GET         | `/api/v1/cases/export`           | `case:read`        | 현재 조직의 세무 업무 목록을 CSV로 내려받기                              |
| GET         | `/api/v1/cases`                  | `case:read`        | 현재 조직의 세무 업무 목록                                               |
| POST        | `/api/v1/cases`                  | `case:write`       | 세무 업무 생성                                                           |
| POST        | `/api/v1/uploads`                | `document:upload`  | 검증 후 격리 저장하고 비동기 작업을 큐에 등록                            |
| GET         | `/api/v1/documents/:id/download` | `document:read`    | 현재 조직에서 색인 완료된 원본 자료 내려받기                             |
| GET         | `/api/v1/documents/:id/evidence` | `workpaper:review` | 담당 세무 검토자용 추출 내용과 전체 체크섬 조회                          |
| PATCH       | `/api/v1/documents/:id/evidence` | `workpaper:review` | 체크섬에 고정해 AI 근거로 승인 또는 제외                                 |
| GET         | `/api/v1/jobs/:id`               | `document:read`    | 현재 조직의 작업 상태 조회                                               |
| POST        | `/api/v1/assistant`              | `assistant:run`    | 세무 업무 범위에서 AI 스트림 실행                                        |
| GET         | `/api/v1/reviews/:id`            | `workpaper:review` | 검토 대상과 산출물 해시에 연결된 승인 토큰 조회                          |
| POST        | `/api/v1/reviews/:id`            | `workpaper:review` | 승인 또는 반려, 토큰 일회성 소비                                         |
| GET         | `/api/v1/audit`                  | `audit:read`       | 최근 감사 이벤트 조회                                                    |

업로드 요청은 multipart `file`, `matterId`와 `Idempotency-Key` 헤더를 요구합니다. AI 요청은 화면 메시지 배열과 `matterId`를 받으며, 서버가 사용자의 세무 업무 접근 권한을 다시 확인합니다. AI 실행은 월간 예산에서 최대 실행 비용을 원자적으로 예약한 뒤 완료 시 실제 추정치로 정산합니다.

## MCP

`/mcp`는 스트리밍 가능한 HTTP MCP 엔드포인트입니다. 공식 TypeScript SDK 서버를 사용하며 상태 비저장 호출을 지원합니다.

| Tool                     | 성격      | 설명                                          |
| ------------------------ | --------- | --------------------------------------------- |
| `list_tax_matters`       | 읽기 전용 | 인증 사용자가 볼 수 있는 세무 업무 목록       |
| `search_matter_evidence` | 읽기 전용 | 지정 세무 업무에서 승인된 현재 버전 근거 검색 |

MCP는 REST와 동일한 OIDC, DB 소속 확인, RBAC, 조직 범위, 요청 제한, 프롬프트 안전 통제와 감사 로그를 재사용합니다. 운영 환경에서는 `MCP_ALLOWED_HOSTS`와 `MCP_ALLOWED_ORIGINS`가 없으면 준비 상태 검사가 실패합니다. 원본 Bearer 토큰은 서버 상태나 로그에 저장하지 않습니다.

쓰기 도구는 MCP에 노출하지 않았습니다. 향후 추가할 경우 사용자 의도 확인, 사전 실행 결과, 산출물 해시에 묶인 승인 토큰과 감사 이벤트를 모두 요구해야 합니다.
