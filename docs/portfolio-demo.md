# 설계 문서와 PDF 생성 방법

## 설계 판단 한 페이지

[설계 판단 원문](engineering-decisions.md)과 [설계 PDF](../output/pdf/taxops-ai-engineering-decisions.pdf)는 같은 내용입니다. 승인 권한 분리, 파일 처리와 알림의 장애 대응, 자동 검사로 놓친 모바일 문제를 다룹니다. 확인 가능한 코드와 실행 기록을 연결하고 실제 운영 환경에서의 검증 여부를 구분했습니다.

PDF는 Python 3, `reportlab`과 한국어 TrueType 폰트가 있는 환경에서 재생성할 수 있습니다.

```bash
python3 scripts/portfolio/build-one-pager.py
```

원문을 수정하면 PDF도 다시 만들고 한 페이지 여부, 링크, 한국어 글꼴과 화면 잘림을 확인해야 합니다. 자동 생성만으로 시각 검수가 완료되는 것은 아닙니다.
