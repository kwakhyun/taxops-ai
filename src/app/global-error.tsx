"use client";

export default function GlobalError() {
  return (
    <html lang="ko">
      <body>
        <main
          style={{
            maxWidth: 640,
            margin: "10vh auto",
            padding: 32,
            fontFamily: "system-ui",
          }}
        >
          <h1>TaxOps AI를 시작하지 못했습니다.</h1>
          <p>
            필수 환경 설정과 서비스 상태를 확인한 뒤 페이지를 새로고침해 주세요.
          </p>
        </main>
      </body>
    </html>
  );
}
