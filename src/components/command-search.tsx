"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  Bot,
  BriefcaseBusiness,
  Files,
  LayoutDashboard,
  LoaderCircle,
  Search,
  ScrollText,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/dialog";
import type { MatterSearchItem } from "@/lib/contracts/listing";
import type { Permission } from "@/lib/domain/types";

interface SearchItem {
  id: string;
  href: string;
  label: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
  permission?: Permission;
}

const destinations: SearchItem[] = [
  {
    id: "dashboard",
    href: "/",
    label: "업무 현황",
    description: "마감 일정과 주요 리스크를 확인합니다.",
    keywords: "대시보드 현황 일정 리스크",
    icon: LayoutDashboard,
  },
  {
    id: "cases",
    href: "/cases",
    label: "세무 업무",
    description: "고객사별 세무 업무를 조회합니다.",
    keywords: "고객사 세목 신고 업무",
    icon: BriefcaseBusiness,
    permission: "case:read",
  },
  {
    id: "documents",
    href: "/documents",
    label: "자료 관리",
    description: "등록 자료와 처리 상태를 확인합니다.",
    keywords: "파일 문서 증빙 원장 자료",
    icon: Files,
    permission: "document:read",
  },
  {
    id: "assistant",
    href: "/assistant",
    label: "AI 분석",
    description: "근거 기반 세무 분석을 실행합니다.",
    keywords: "질문 분석 생성형 AI",
    icon: Bot,
    permission: "assistant:run",
  },
  {
    id: "reviews",
    href: "/reviews",
    label: "검토 및 승인",
    description: "검토조서와 검색 근거를 검토합니다.",
    keywords: "검토 승인 반려 조서",
    icon: BadgeCheck,
    permission: "workpaper:review",
  },
  {
    id: "operations",
    href: "/operations",
    label: "운영 현황",
    description: "서비스 상태와 실행 추적을 확인합니다.",
    keywords: "운영 모니터링 추적 지연 비용",
    icon: Activity,
    permission: "audit:read",
  },
  {
    id: "evaluations",
    href: "/evaluations",
    label: "AI 품질 평가",
    description: "평가 기준과 최근 품질 결과를 확인합니다.",
    keywords: "평가 품질 인용 정확도",
    icon: ShieldCheck,
    permission: "audit:read",
  },
  {
    id: "audit",
    href: "/audit",
    label: "감사 로그",
    description: "사용자 작업과 보안 통제 이력을 조회합니다.",
    keywords: "감사 로그 이력 추적 기록",
    icon: ScrollText,
    permission: "audit:read",
  },
];

function matterSearchItem(matter: MatterSearchItem): SearchItem {
  return {
    id: `matter-${matter.id}`,
    href: `/cases/${matter.id}`,
    label: matter.client,
    description: `${matter.taxType} · ${matter.period}`,
    keywords: `${matter.client} ${matter.taxType} ${matter.period} ${matter.summary}`,
    icon: BriefcaseBusiness,
  };
}

export function CommandSearch({ permissions }: { permissions: Permission[] }) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matters, setMatters] = useState<MatterSearchItem[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const canReadCases = permissions.includes("case:read");

  const pathname = usePathname();
  const cache = useRef(
    new Map<string, { at: number; items: MatterSearchItem[] }>(),
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || !canReadCases) return;
    const controller = new AbortController();
    const key = `${pathname}:${query.trim()}`;
    const timer = setTimeout(async () => {
      setError("");
      const cached = cache.current.get(key);
      if (cached && Date.now() - cached.at < 30000 && retry === 0) {
        setMatters(cached.items);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const response = await fetch(
          `/api/v1/cases/search?q=${encodeURIComponent(query.trim())}`,
          {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        );
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.data))
          throw new Error(
            payload.error?.message ?? "검색 대상을 불러오지 못했습니다.",
          );
        if (!controller.signal.aborted) {
          if (cache.current.size >= 20) cache.current.clear();
          cache.current.set(key, { at: Date.now(), items: payload.data });
          setMatters(payload.data);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setMatters([]);
          setError(
            cause instanceof Error ? cause.message : "검색 대상 조회 실패",
          );
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, canReadCases, query, pathname, retry]);

  const openSearch = useCallback(() => {
    setOpen(true);
  }, []);

  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          setOpen(false);
          setQuery("");
        } else {
          openSearch();
        }
      }
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [open, openSearch]);

  const results = useMemo(() => {
    const allowedDestinations = destinations.filter(
      (item) => !item.permission || permissions.includes(item.permission),
    );
    const allItems = [
      ...allowedDestinations,
      ...(canReadCases ? (matters ?? []) : []).map(matterSearchItem),
    ];
    const normalized = query.trim().toLocaleLowerCase("ko-KR");
    if (!normalized) return allItems.slice(0, 9);
    return allItems
      .filter((item) =>
        `${item.label} ${item.description} ${item.keywords}`
          .toLocaleLowerCase("ko-KR")
          .includes(normalized),
      )
      .slice(0, 9);
  }, [matters, permissions, query, canReadCases]);

  function close() {
    setOpen(false);
    setQuery("");
  }

  return (
    <>
      <button
        ref={triggerRef}
        className="command-search"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="고객사, 세목, 화면 검색"
        onClick={openSearch}
      >
        <Search size={17} aria-hidden="true" />
        <span>고객사, 세목, 화면 검색</span>
        <kbd>⌘ K</kbd>
      </button>

      <Dialog
        returnFocusRef={triggerRef}
        open={open}
        title="통합 검색"
        onClose={close}
        className="command-dialog"
        header={
          <header className="command-palette-header">
            <Search size={18} aria-hidden="true" />
            <label htmlFor="command-palette-input" className="sr-only">
              통합 검색어
            </label>
            <input
              id="command-palette-input"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                const first = results[0];
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  first
                ) {
                  event.preventDefault();
                  close();
                  router.push(first.href);
                }
              }}
              placeholder="고객사, 세목, 화면 이름 검색"
              autoComplete="off"
              autoFocus
            />
            <button
              className="icon-button"
              type="button"
              aria-label="통합 검색 닫기"
              onClick={close}
            >
              <X size={16} />
            </button>
          </header>
        }
        footer={
          <footer className="command-palette-footer">
            <span>Esc 닫기</span>
            <span>Enter 열기</span>
          </footer>
        }
      >
        <div className="command-palette-results" aria-live="polite">
          {loading ? (
            <div className="command-palette-state" role="status">
              <LoaderCircle className="spin" size={17} /> 검색 대상을 불러오는
              중입니다.
            </div>
          ) : null}
          {error ? (
            <div
              className="command-palette-state command-palette-error"
              role="alert"
            >
              {error}
              <button
                type="button"
                className="button button-secondary button-compact"
                onClick={() => setRetry((value) => value + 1)}
              >
                다시 시도
              </button>
            </div>
          ) : null}
          {!loading && results.length === 0 ? (
            <div className="command-palette-state">
              일치하는 항목이 없습니다.
            </div>
          ) : null}
          {results.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.id} href={item.href} onClick={close}>
                <span className="command-result-icon">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </Link>
            );
          })}
        </div>
      </Dialog>
    </>
  );
}
