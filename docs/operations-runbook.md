# 운영 런북

## 배포 전 확인

1. `npm ci` 후 `npm run verify`와 `npm run test:e2e`를 통과합니다.
2. migration을 staging clone에 적용하고 RLS의 허용·차단 케이스를 확인합니다.
3. commit SHA로 web, worker 이미지를 만들고 immutable tag와 digest를 기록합니다.
4. Terraform plan을 cloud·security 담당자가 검토합니다.
5. OIDC client와 session secret, DB 역할별 URL, AI key, 승인 secret, DLP·의미 분류기·문서 처리 token, 알림 HMAC secret을 Secrets Manager에서 주입합니다.
6. `/api/health/ready`의 DB·Reviewer probe와 보안 설정 검증을 통과하고, Worker 시작 로그에서 DB·S3·ClamAV probe 성공을 확인합니다.
7. 새 프롬프트·모델이 있으면 평가 report와 Reviewer 승인 기록을 배포 변경에 첨부합니다.
8. `TAXOPS_LOCAL_STACK`이 production task definition에 없고, 실제 의미 분류기의 host, 처리 지역, threshold와 승인된 modelVersion이 staging 평가 기록과 일치하는지 확인합니다.
9. 전체 감사 체인 검증의 count와 head hash를 외부 WORM 저장소의 최근 서명 anchor와 대조합니다.

## 권장 SLO와 경보

| 항목           | 목표                | 경보 예시                           |
| -------------- | ------------------- | ----------------------------------- |
| 웹 가용성      | 월 99.9%            | 5분 성공률 99% 미만                 |
| REST p95       | 800ms 이하, AI 제외 | 10분 연속 초과                      |
| AI p95         | 20초 이하           | 15분 연속 초과                      |
| 작업 지연      | p95 5분 이하        | oldest queued job 10분 초과         |
| 작업 DLQ       | 0 지속              | 1건 즉시 알림                       |
| 인용 유효성    | 100%                | 한 건이라도 실패 시 AI rollout 중단 |
| tenant leakage | 0건                 | 즉시 P0 incident                    |
| 요청당 AI 비용 | 제품 예산 이내      | 일일 예산 80%, 100% 단계 알림       |

## 주요 대시보드

- HTTP: 요청 수, 상태 코드, p50/p95/p99, route별 error rate
- AI: 모델·프롬프트·검색 버전별 지연, token, 비용, 기권, verifier rejection
- 검색: hit 수, score 분포, Recall shadow sample, citation count
- 워커: queue depth, oldest age, lease expiry, retry, DLQ, parser/ClamAV 오류
- 알림: outbox 대기 수, 전송 시도, 10회 실패 이벤트, webhook 응답 코드
- 보안: OIDC 실패, RBAC deny, tenant mismatch, approval replay, MCP host/origin deny
- 데이터: DB connection, slow query, storage growth, backup와 restore 상태

로그에는 request ID, trace ID, actor ID, tenant ID, 대상 ID와 결과 코드만 허용하며 파일 내용, 질문, 답변, 이메일, access token은 남기지 않습니다.

## 장애 대응

### 교차 테넌트 노출 의심

AI와 MCP 트래픽을 즉시 차단하고 incident를 P0로 선언합니다. 관련 trace ID, 배포 digest, DB audit chain을 보존한 뒤 RLS와 repository filter를 확인합니다. 원문을 일반 로그에 복사하지 않습니다. 영향 tenant와 법적 통지 여부는 보안·개인정보 담당자가 판단합니다.

### AI 근거 오류 증가

현재 model/prompt/retrieval version의 rollout을 중단합니다. 이전 검증 버전으로 되돌리고 실패 질문을 비식별 golden set에 추가합니다. 검색 실패, tool 계산, verifier 누락을 단계별로 분리해 조사합니다.

### 문서 작업 정체

oldest job, lease owner와 expiry, ClamAV, processor, S3, DB 상태를 확인합니다. lease가 만료되면 다른 워커가 자동 재임대합니다. 영구 실패는 원인 수정 후 새 idempotency key로 명시적으로 재처리하고 원래 감사 기록은 유지합니다.

### 알림 전송 정체

`outbox_events`의 `available_at`, `attempts`, `last_error_code`를 확인합니다. 워커는 idempotency key와 HMAC 서명을 포함해 HTTPS webhook을 호출하며 실패 시 지수 재시도를 예약합니다. 10회를 소진한 이벤트는 원인을 해결한 뒤 신규 idempotency key로 재발행합니다.

### 객체 저장소·DB 장애

새 업로드와 쓰기 기능을 중단하고 읽기 범위를 최소화합니다. RDS point-in-time restore와 S3 version을 별도 복구 환경에서 검증합니다. audit chain 연속성과 object checksum을 확인한 뒤 서비스를 재개합니다.

### 의미 분류기 장애 또는 보안 재스캔

분류기 timeout, response schema 불일치, 처리 지역 불일치는 fail-closed로 문서 인덱싱을 중단합니다. 대체 모델로 자동 우회하지 말고 승인된 modelVersion을 복구합니다. 분류 정책 변경 migration이 기존 `INDEXED` 문서를 `QUARANTINED`로 되돌리면 immutable object binding이 있는 문서만 재처리하고, binding이 없는 문서는 `FAILED` remediation 이벤트로 조사합니다. 관련 근거가 다시 `SAFE`, `INDEXED`, `APPROVED`가 되기 전에는 연결된 pending 워크페이퍼를 승인하지 않습니다.

### 공식 세무 원천 또는 감사 anchor 불일치

공식 원천의 publisher, HTTPS URI와 수집 시각만으로 진위를 확정하지 않습니다. connector가 검증한 서명 또는 승인 digest와 맞지 않으면 `TAX_AUTHORITY` 자료를 검색에서 제외하고 보안 담당자와 세무 지식 관리자가 재수집합니다. DB 전체 감사 체인은 tamper-evident 통제이며 외부 WORM anchor가 없거나 head hash가 다르면 쓰기 기능을 중단하고 별도 복구 환경에서 조사합니다.

## 롤백

- 애플리케이션: 이전 이미지 digest로 ECS task definition을 되돌립니다.
- 프롬프트·모델: 이전 승인 버전을 feature configuration에서 선택합니다.
- DB: expand/contract migration을 원칙으로 합니다. destructive down migration 대신 이전 앱이 읽을 수 있는 호환 상태를 유지합니다.
- 문서 인덱스: `document_version`과 `is_current`로 이전 청크를 보존하고 검증된 버전만 다시 current로 전환합니다.

## 정기 운영

- 매일: DLQ, 비용, 보안 deny 이상치, backup 성공 확인
- 매주: 품질 표본 Reviewer 검토, dependency와 container 취약점 점검
- 매월: 복구 훈련, 권한 검토, KMS·secret 정책, 세무 golden set 확장
- 분기: 침투 테스트, 개인정보·보존 정책 검토, SLO와 비용 기준 재조정
