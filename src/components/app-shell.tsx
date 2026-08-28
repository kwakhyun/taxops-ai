"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BadgeCheck,
  Bot,
  BriefcaseBusiness,
  ChevronDown,
  Files,
  LayoutDashboard,
  Landmark,
  LogOut,
  Menu,
  Plus,
  ScrollText,
  Search,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { clsx } from "clsx";
import type { Permission, Role, SessionUser } from "@/lib/domain/types";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  count?: number;
  permission?: Permission;
};

const navItems: NavItem[] = [
  { href: "/", label: "업무 현황", icon: LayoutDashboard },
  {
    href: "/cases",
    label: "세무 케이스",
    icon: BriefcaseBusiness,
    permission: "case:read",
  },
  {
    href: "/assistant",
    label: "AI 워크벤치",
    icon: Bot,
    badge: "Beta",
    permission: "assistant:run",
  },
  {
    href: "/documents",
    label: "문서 보관함",
    icon: Files,
    permission: "document:read",
  },
  {
    href: "/reviews",
    label: "검토·승인",
    icon: BadgeCheck,
    permission: "workpaper:review",
  },
];

const operationItems: NavItem[] = [
  {
    href: "/operations",
    label: "운영 관제",
    icon: Activity,
    permission: "audit:read",
  },
  {
    href: "/evaluations",
    label: "AI 평가",
    icon: ShieldCheck,
    permission: "audit:read",
  },
  {
    href: "/audit",
    label: "감사 로그",
    icon: ScrollText,
    permission: "audit:read",
  },
];

const roleLabel: Record<Role, string> = {
  ANALYST: "세무 실무자",
  REVIEWER: "세무 검토자",
  ADMIN: "워크스페이스 관리자",
};

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === href;
  return pathname.startsWith(href);
}

function NavGroup({
  items,
  pathname,
  onNavigate,
  label,
  permissions,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate: () => void;
  label: string;
  permissions: Permission[];
}) {
  const visibleItems = items.filter(
    (item) => !item.permission || permissions.includes(item.permission),
  );
  return (
    <nav className="nav-list" aria-label={label}>
      {visibleItems.map((item) => {
        const Icon = item.icon;
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={clsx("nav-item", active && "nav-item-active")}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
            <span>{item.label}</span>
            {item.badge ? (
              <span className="nav-badge">{item.badge}</span>
            ) : null}
            {item.count ? (
              <span className="nav-count">{item.count}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({
  children,
  user,
  permissions,
  portfolioDemo,
}: {
  children: ReactNode;
  user: SessionUser;
  permissions: Permission[];
  portfolioDemo: boolean;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = () => setMobileViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!mobileOpen) return;
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  function trapMobileFocus(event: KeyboardEvent<HTMLElement>) {
    if (!mobileViewport || !mobileOpen || event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="app-frame">
      <aside
        id="primary-navigation"
        className={clsx("sidebar", mobileOpen && "sidebar-open")}
        inert={mobileViewport && !mobileOpen ? true : undefined}
        aria-hidden={mobileViewport && !mobileOpen ? true : undefined}
        onKeyDown={trapMobileFocus}
      >
        <div className="brand-row">
          <Link href="/" className="brand" onClick={() => setMobileOpen(false)}>
            <span className="brand-mark" aria-hidden="true">
              <Landmark size={19} strokeWidth={2.2} />
            </span>
            <span className="brand-copy">
              <strong>TaxOps</strong>
              <small>TAX INTELLIGENCE</small>
            </span>
          </Link>
          <button
            ref={closeButtonRef}
            className="sidebar-close"
            type="button"
            aria-label="메뉴 닫기"
            onClick={() => setMobileOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <div className="workspace-switcher">
          <span className="workspace-avatar">
            {user.tenantName.slice(0, 1)}
          </span>
          <span className="workspace-copy">
            <strong>{user.tenantName}</strong>
            <small>세무 업무 공간</small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </div>

        <div className="sidebar-section">
          <span className="sidebar-label">업무</span>
          <NavGroup
            items={navItems}
            pathname={pathname}
            onNavigate={() => setMobileOpen(false)}
            label="워크스페이스 메뉴"
            permissions={permissions}
          />
        </div>

        <div className="sidebar-section">
          <span className="sidebar-label">관리</span>
          <NavGroup
            items={operationItems}
            pathname={pathname}
            onNavigate={() => setMobileOpen(false)}
            label="운영 메뉴"
            permissions={permissions}
          />
        </div>

        <div className="sidebar-spacer" />

        <div className="security-card">
          <span className="security-icon">
            <ShieldCheck size={18} />
          </span>
          <div>
            <strong>보안 통제 활성</strong>
            <p>권한, 근거, 감사 추적이 적용 중입니다.</p>
          </div>
        </div>

        <div className="sidebar-user">
          <span className="user-avatar">{user.initials}</span>
          <span className="user-copy">
            <strong>{user.name}</strong>
            <small>{roleLabel[user.role]}</small>
          </span>
          <form action="/api/auth/logout" method="post">
            <button
              className="icon-button"
              type="submit"
              title="로그아웃"
              aria-label="로그아웃"
            >
              <LogOut size={15} />
            </button>
          </form>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="메뉴 닫기"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <div className="app-main">
        <header className="topbar">
          <button
            ref={menuButtonRef}
            className="mobile-menu"
            type="button"
            aria-label="메뉴 열기"
            aria-controls="primary-navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={21} />
          </button>

          <Link
            className="command-search"
            href="/cases"
            aria-label="케이스 검색 열기"
          >
            <Search size={17} />
            <span>케이스, 문서, 거래처 검색</span>
            <kbd>⌘ K</kbd>
          </Link>

          <div className="topbar-actions">
            <span className="environment-pill">
              <span /> 보안 통제 활성
            </span>
            <Link
              href="/cases/new"
              className="button button-primary button-compact"
            >
              <Plus size={16} /> 새 케이스
            </Link>
          </div>
        </header>

        {portfolioDemo ? (
          <div className="portfolio-demo-banner" role="status">
            <ShieldCheck size={15} aria-hidden="true" />
            <strong>포트폴리오 데모</strong>
            <span>
              예시 데이터만 사용하며 입력 내용은 영구 저장되지 않습니다.
            </span>
          </div>
        ) : null}

        <main className="page-canvas">{children}</main>
      </div>
    </div>
  );
}
