"use client";

import { useEffect, useState } from "react";
import type { PageResult } from "@/lib/contracts/listing";

export function usePagedQuery<T>(
  endpoint: string,
  query: string,
  initial: PageResult<T>,
  initialQuery: string,
) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({
    query: initialQuery,
    result: initial,
    error: "",
    retry: 0,
  });
  const loading = state.query !== query || state.retry !== retry;
  useEffect(() => {
    if (query === state.query && retry === state.retry) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${endpoint}?${query}`, {
          cache: "no-store",
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15000),
          ]),
        });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.data))
          throw new Error(
            payload.error?.message ?? "목록을 불러오지 못했습니다.",
          );
        if (!controller.signal.aborted)
          setState({
            query,
            retry,
            result: {
              items: payload.data,
              total: payload.meta.total,
              page: payload.meta.page,
              pageSize: payload.meta.pageSize,
            },
            error: "",
          });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            query,
            retry,
            result: { ...initial, items: [], total: 0 },
            error: error instanceof Error ? error.message : "목록 조회 실패",
          });
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, query, retry, state.query, state.retry, initial]);
  return {
    result: state.result,
    error: state.error,
    loading,
    reload: () => setRetry((value) => value + 1),
  };
}
