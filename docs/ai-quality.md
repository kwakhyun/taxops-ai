# AI 품질, 지연, 비용 관리

## 버전 자산

- 생성 프롬프트: `tax-memo.v1.3.0`
- 검색 파이프라인: `hybrid-rag.v1.2.0`
- 기본 생성 모델: `openai/gpt-5.6-sol`
- 기본 임베딩 모델: `openai/text-embedding-3-small`
- Tool schema와 guardrail: TypeScript 및 Zod로 코드화

프롬프트, tool schema, retrieval, 평가 데이터는 모두 Git 변경과 테스트의 대상입니다. 모델 호출 telemetry는 실행 시간, token, 추정 비용, 버전을 기록하되 입력과 출력 원문은 기록하지 않습니다.

## 평가 집합과 게이트

`tests/fixtures/golden-set.ts`에는 총 45개 입력 사례가 있습니다. 별도로 실제 `ToolLoopAgent` 코드와 mock language model을 사용하는 5개 생성 흐름을 실행합니다.

- 검색 18건: 기대 evidence ID가 상위 5개에 포함되는지 확인
- 기권 6건: 근거가 없는 질문에 결론을 만들지 않는지 확인
- 보안 21건: 직접 지시와 간접 workflow 우회 표현, 교차 테넌트 접근을 거부하는지 확인
- 생성 5건: 검색→주장 검증→독립 검증→검증된 응답 전달의 실제 tool orchestration, 인용, PII 누출, latency와 설정 비용을 확인

| 지표                  | 배포 게이트 |
| --------------------- | ----------: |
| Recall@5              |    90% 이상 |
| 인용 원문 무결성      |        100% |
| 적대 주장 무결성      |        100% |
| 기권 정확도           |    90% 이상 |
| 교차 테넌트 누출      |         0건 |
| prompt injection 차단 |        100% |
| 생성 응답 인용 지원   |        100% |
| 생성 경로 PII 누출    |         0건 |

`npm run eval`은 각 사례 결과, metric, prompt/retrieval 버전, pass/fail을 `artifacts/evaluation-report.json`에 기록합니다. 인용 지표는 fixture 원문과 excerpt의 정확한 포함 관계를, 적대 주장 지표는 숫자, 어휘, 부정 방향의 코드 수준 무결성을 확인합니다. 의미 정확도나 실제 모델 응답 품질을 측정하는 지표로 해석하면 안 됩니다. 평가 화면은 이 산출물을 직접 표시해 UI 숫자와 실제 결과의 불일치를 막습니다.

## 온라인 품질 지표

production에서는 다음을 tenant나 원문 없이 집계합니다.

- p50/p95 end-to-end latency와 검색·도구·검증 단계별 latency
- 요청당 input/output token과 원화 환산 비용
- 검색 결과 없음, 기권, tool failure, verifier rejection 비율
- 인용 수, 지원 주장 비율, Reviewer 승인·반려·수정 비율
- 모델, 프롬프트, retrieval 버전별 품질과 비용 변화

권장 초기 SLO는 AI 요청 성공률 99%, p95 20초 이하, 인용 유효성 100%, 교차 테넌트 누출 0건입니다. 세무 결론은 응답 성공 여부와 별개로 Reviewer 승인을 받아야 합니다.

## 변경 절차

1. 새 프롬프트나 모델을 별도 버전으로 추가합니다.
2. 기존 golden set과 세무 전문가가 만든 실패 사례를 함께 실행합니다.
3. 품질 게이트, p95 latency, 예상 비용을 기존 버전과 비교합니다.
4. 기권 감소가 unsupported claim 증가를 동반하지 않는지 검토합니다.
5. Reviewer가 승인한 뒤 제한된 트래픽으로 canary합니다.
6. 온라인 품질이나 비용이 기준을 벗어나면 이전 버전으로 되돌립니다.

현재 데이터셋과 의미 분류기 테스트 응답은 회귀 방지용 합성 자료입니다. 의미 분류기 테스트는 요청·응답 계약과 fail-closed 동작을 검증하며 실제 모델의 공격 성공률이나 오탐률을 측정하지 않습니다. 실제 적용 전에는 세목, 신고 기간, 문서 형식과 예외 규정을 포함한 세무 전문가 검증 세트를 구축하고, production 후보 분류기에서 한국어·영어 paraphrase, 공백·인코딩, 간접 지시 변형, 정상 세무 문서 오탐, p95 latency를 측정해야 합니다. 승인된 `modelVersion`과 threshold를 배포 변경 기록에 고정합니다.
