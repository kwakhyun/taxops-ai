# 아키텍처와 데이터 흐름

## 설계 목표

TaxOps AI는 세무 전문가의 판단을 대체하지 않습니다. 검역된 고객 자료에서 근거를 찾고, 계산 가능한 부분은 결정론적 도구로 처리하며, 결론과 근거의 연결을 별도로 검증한 뒤 세무 검토자에게 승인 가능한 초안을 제공하는 것이 목표입니다.

## 문서 용어 기준

화면과 문서에서는 조직, 세무 업무, 자료, 검토조서, 세무 검토자를 기본 용어로 사용합니다. 코드나 데이터베이스 식별자를 설명할 때만 `tenant`, `matter`, `document`, `workpaper`, `reviewer`를 그대로 표시합니다. 사람인 세무 검토자와 독립 실행 환경인 검토 서비스를 구분합니다.

## 런타임 경계

```mermaid
flowchart TB
  Browser[Next.js UI] --> Proxy[요청 ID·CSP·Origin 검사]
  Proxy --> API[Route Handlers]
  API --> Auth[OIDC + revocable DB session + RBAC]
  API --> Repo[Repository boundary]
  Repo --> DB[(PostgreSQL + pgvector + RLS)]
  API --> ReviewService[독립 검토 서비스]
  ReviewService --> DB
  API --> S3[(Private quarantine bucket)]
  API --> Queue[(Durable jobs table)]
  Worker[Ingestion worker] --> Queue
  Worker --> AV[ClamAV]
  Worker --> Processor[Private document processor]
  Worker --> Classifier[Semantic source-instruction classifier]
  Worker --> Gateway[AI Gateway embeddings]
  Worker --> DB
  API --> Agent[Bounded Tax Agent]
  Agent --> Retriever[Hybrid retrieval]
  Retriever --> DB
  Agent --> Tools[Read/calculation/dry-run tools]
  Agent --> Verifier[Independent verifier]
  MCP[Streamable HTTP MCP] --> Auth
  MCP --> Repo
```

웹 런타임, 워커와 검토 서비스는 별도 컨테이너와 DB 역할을 사용합니다. 웹은 검토조서 이력 테이블을 직접 변경할 수 없습니다. 검토 서비스는 별도 OIDC 대상값과 권한 범위, 최근 MFA 인증을 검증한 뒤 제한된 DB 함수만 호출합니다.

API는 `src/lib/repository` 경계를 통해 데모 저장소와 PostgreSQL 저장소를 교체합니다. `DATABASE_URL`이 없으면 로컬 데모가 동작합니다.

운영 환경의 웹 준비 상태 검사는 DB와 검토 서비스 연결을 확인하고 나머지 필수 서비스의 보안 설정을 검증합니다. 워커는 시작할 때 DB, 객체 저장소와 ClamAV 연결을 확인합니다. 인증된 개인정보 비식별화 서비스, 문서 처리기와 의미 분류기 설정도 강제합니다.

## 제품 정보구조와 반응형 경계

데스크톱은 기존 TaxOps AI의 권한별 사이드바와 서버 컴포넌트 중심 구조를 유지합니다. 대시보드는 마감, 위험, 자료 누락, 검토 대기와 예정 일정을 한 화면에서 우선순위로 묶는 관제 화면으로 구성합니다. 개별 세무 업무는 다음 6단계 Engagement 흐름을 공통 정보구조로 사용합니다.

1. 업무 개요
2. 자료 수집
3. 근거 검토
4. 계산 및 초안
5. 검토 및 승인
6. 신고 및 사후 관리

모바일에서는 역할에 허용된 메뉴만 고정 하단 내비게이션으로 제공하고, 현재 고객사·세목·과세기간을 간결한 상단 맥락 영역에 유지합니다. AI 파트너는 대화와 참고 근거를 탭으로 분리하고 실행 범위는 접이식 안내로 제공합니다. `visualViewport` 기반 화면 높이, 한 개의 대화 스크롤 영역과 독립된 입력창으로 짧은 화면에서도 조작부가 잘리지 않도록 합니다. 키보드가 열리면 하단 내비게이션을 접고 대화 및 입력 공간을 우선하며 핀치 확대는 방해하지 않습니다.

AI 자료 첨부, 통합 검색과 근거 검토는 공통 네이티브 `Dialog`를 사용합니다. 포커스 복귀, 키보드 순환, 본문 스크롤과 고정된 승인 버튼을 같은 규칙으로 관리합니다. 모바일 표는 필드명이 있는 레코드로 재배치하고, 태블릿의 넓은 표는 `TableViewport` 안에서만 가로 스크롤하도록 하며 키보드 접근과 스크롤 안내를 제공합니다. 이 구조는 별도 모바일 애플리케이션이 아니라 같은 URL과 권한 경계를 공유하는 반응형 표현 계층입니다.

주요 화면은 Axe 자동 검사와 고정 뷰포트 시각 회귀 기준선으로 검증합니다. 키보드 건너뛰기 링크, 현재 위치를 나타내는 `aria-current`, 진행률 이름과 44px 이상의 모바일 조작 영역을 공통 규칙으로 적용합니다.

시각 기준선은 `darwin`과 `linux` 디렉터리로 분리합니다. 시스템 글꼴과 스크롤바가 다른 운영체제의 캡처를 같은 이미지로 비교하지 않습니다. Linux 검사는 Ubuntu 24.04에서 실행하며, 수동 `visual-baseline-candidates` 워크플로가 만든 후보를 검수 후 커밋합니다. 일반 CI에서는 기준선을 자동 갱신하지 않으며, 실패한 화면과 추적 자료는 `browser-e2e-report` 산출물로 7일간 보관합니다. `TableViewport`는 서버가 처음 렌더링한 상태에서도 키보드로 접근할 수 있고, 폭 측정 후 스크롤이 필요 없는 경우에만 추가 포커스 지점을 제거합니다.

작은 텍스트는 `rem` 기반 공통 토큰으로 관리하며 기본 16px 루트 크기에서 보조 정보 12px, 레이블과 보조 본문 13px, 주요 업무 본문 14px를 사용합니다. 모바일 입력은 16px로 유지합니다. 10개 업무 화면을 데스크톱, 태블릿, 작은 모바일과 가로 모드를 포함한 6개 뷰포트에서 검사합니다. 모바일·데스크톱 전체 화면의 Axe 검사 외에도 AI 입력창의 실제 위치, 모달 포커스, 오류 복구와 단계별 업무 등록을 검증합니다.

## 주요 흐름

### 문서 수집

1. API가 사용자 권한과 세무 업무 소속을 확인합니다.
2. 확장자, MIME, 파일 서명, 크기와 경로 안전성을 검증하고 SHA-256을 계산합니다.
3. 파일을 세무 업무별 격리 키에 저장한 뒤 자료 레코드와 작업을 한 트랜잭션에서 만듭니다.
4. 워커가 `FOR UPDATE SKIP LOCKED` 기반 보안 함수로 작업을 임대합니다.
5. 업로드 시 받은 S3 버전 ID, ETag와 SHA-256을 다시 확인하고 ClamAV를 통과한 정확한 객체만 정제 영역으로 옮깁니다. PDF, DOCX와 XLSX는 비공개 처리 서비스를 사용합니다.
6. 파일명, 발행기관, URI, 본문과 구역명을 개인정보 비식별화 처리한 후 인증된 의미 분류기로 검사합니다. 결과의 모델 버전, 임계값과 점수를 자료에 기록합니다.
7. 청크, 임베딩과 근거 명세를 새 버전으로 기록한 뒤에만 `SAFE` 자료를 `INDEXED`로 전환합니다.
8. 세무 검토자가 정확한 체크섬, 버전과 근거 명세에 묶어 승인한 뒤에만 RAG 검색에 포함합니다.
9. 실패는 제한된 재시도와 무작위 지연을 거쳐 DLQ 상태로 이동합니다.

검역 이전 자료, 승인되지 않은 문서, 과거 버전 청크는 검색 쿼리에서 제외됩니다.

### AI 분석

1. 요청 길이, 프롬프트 인젝션 패턴, 요청 제한, 사용자 권한과 세무 업무 소속을 확인합니다.
2. 질문을 임베딩하고 벡터 유사도 65%, PostgreSQL 전문 검색 35%의 혼합 점수로 검색합니다.
3. 검색은 `tenant_id`, `matter_id`, `is_current`, `document.status = INDEXED`, `evidence_status = APPROVED`, 해당 과세기간의 효력 기간을 모두 강제합니다.
4. 주 에이전트는 최대 8단계와 실행 예산 안에서 검색, 계산, 근거 확인, 검토조서 제안 도구를 사용합니다.
5. 쓰기 성격의 도구는 실제 변경 대신 승인 대상 초안을 만듭니다.
6. 별도 검증 에이전트가 주장별 근거와 계산을 확인합니다. 근거가 부족하면 답변을 보류합니다.
7. 세무 검토자 승인 전 결과는 외부 게시 가능한 상태가 아닙니다.

## 데이터 모델

핵심 데이터 모델은 19개 테이블과 8개 enum으로 구성됩니다. 테이블은 `tenants`, `users`, `memberships`, `web_sessions`, `clients`, `matters`, `documents`, `document_chunks`, `jobs`, `outbox_events`, `rate_limit_buckets`, `prompt_versions`, `agent_runs`, `retrieval_events`, `tool_calls`, `workpapers`, `workpaper_versions`, `approvals`, `audit_events`입니다. enum은 `membership_role`, `matter_status`, `risk_level`, `document_status`, `job_status`, `workflow_status`, `approval_status`, `audit_outcome`입니다.

- 모든 고객 데이터는 조직을 식별하는 `tenant_id`를 포함합니다.
- 브라우저 세션의 `jti`는 `web_sessions`에 기록하며 로그아웃 시 즉시 폐기합니다.
- 중요한 관계는 조직 ID를 포함한 복합 외래 키로 연결합니다.
- RLS는 요청별 `app.tenant_id` 설정을 기준으로 읽기와 쓰기를 제한합니다.
- 감사 이벤트는 이전 해시를 포함하고 애플리케이션에서 수정·삭제할 수 없습니다. DB 검증기가 조회 제한과 무관하게 해당 조직의 전체 체인을 재계산합니다.
- 업로드 작업은 조직 범위 멱등성 키로 중복 생성을 막습니다.

## 고장 처리

- AI Gateway 오류: 재시도 제한 후 사용자에게 추적 가능한 오류를 반환하며, 근거 없는 대체 결론을 만들지 않습니다.
- 검색 결과 없음: 답변을 보류하고 필요한 자료를 안내합니다.
- 파일 처리 실패: 문서를 `FAILED`로 표시하고 검색에서 제외합니다.
- 워커 중단: 임대 시간이 끝나면 다른 워커가 작업을 다시 임대합니다.
- 알림 전송 중단: Outbox 임대가 만료된 뒤 다른 워커가 같은 멱등성 키로 다시 전송합니다.
- 승인 토큰 재사용: 행위와 산출물 해시에 결합된 서명을 검증하고, 조건부 DB 갱신으로 `PENDING`을 정확히 한 번만 전이합니다. 최종 함수는 최소 1건의 근거 ID, 원문, 위치, 출처 유형, 출처 이력과 해시를 현재 DB 필드와 대조하고 승인 기록과 AI 실행 상태를 한 트랜잭션에서 전이합니다.
- DB 또는 필수 운영 설정 누락: 준비 상태 API가 503을 반환합니다.
