"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const terminal = new Set(["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"]);
const labels: Record<string, string> = {
  QUEUED: "보안 검사 대기",
  RUNNING: "자료 처리 중",
  RETRYING: "자료 처리 재시도 중",
  SUCCEEDED: "자료 처리 완료 · 근거 사용 승인 대기",
  FAILED: "자료 처리 실패 · 자료를 확인해 주세요",
  DEAD: "재시도 한도 초과 · 담당자 확인 필요",
  CANCELLED: "자료 처리 취소됨",
};

export function IngestionJobStatus({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ text: "보안 검사 대기", retry: false });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    async function poll() {
      try {
        const response = await fetch(`/api/v1/jobs/${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        const payload = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok || !payload.data)
          throw new Error(
            payload.error?.message ?? "처리 상태를 확인하지 못했습니다.",
          );
        if (payload.meta?.processingAvailable === false) {
          setState({
            text: "시연 모드에서는 대기열 등록까지만 진행됩니다.",
            retry: false,
          });
          return;
        }
        const status = payload.data.status as string;
        const progress = Number(payload.data.progress);
        setState({
          text: `${labels[status] ?? "처리 상태 확인 중"}${!terminal.has(status) && Number.isFinite(progress) ? ` · ${Math.max(0, Math.min(100, progress))}%` : ""}`,
          retry: false,
        });
        if (terminal.has(status)) {
          router.refresh();
          return;
        }
        if (Date.now() - started >= 120000) {
          setState({
            text: "처리가 계속되고 있습니다. 상태 확인을 다시 시작할 수 있습니다.",
            retry: true,
          });
          return;
        }
        timer = setTimeout(poll, 3000);
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            text:
              error instanceof Error ? error.message : "처리 상태 확인 실패",
            retry: true,
          });
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, attempt, router]);
  return (
    <div className="ingestion-job-status" aria-live="polite" data-job-id={id}>
      <strong>{name}</strong>
      <span>{state.text}</span>
      {state.retry ? (
        <button
          type="button"
          className="button button-secondary button-compact"
          onClick={() => setAttempt((value) => value + 1)}
        >
          처리 상태 다시 확인
        </button>
      ) : null}
    </div>
  );
}
