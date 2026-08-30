"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("route.error", { name: error.name, digest: error.digest });
  }, [error]);

  return (
    <section className="empty-state card" role="alert">
      <span className="empty-state-icon">
        <TriangleAlert size={24} />
      </span>
      <h1>화면을 불러오지 못했습니다.</h1>
      <p>
        입력 내용은 다시 전송하지 않았습니다. 잠시 후 재시도하고 문제가 계속되면
        관리자에게 문의해 주세요.
      </p>
      {error.digest ? (
        <p>
          오류 코드: <code>{error.digest}</code>
        </p>
      ) : null}
      <button className="button button-primary" type="button" onClick={reset}>
        <RotateCcw size={15} /> 다시 시도
      </button>
    </section>
  );
}
