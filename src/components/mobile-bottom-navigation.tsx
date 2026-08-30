import Link from "next/link";
import {
  BadgeCheck,
  Bot,
  BriefcaseBusiness,
  Files,
  Home,
  type LucideIcon,
} from "lucide-react";
import { clsx } from "clsx";
import type { Permission } from "@/lib/domain/types";

type MobileItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
};

const items: MobileItem[] = [
  { href: "/", label: "홈", icon: Home },
  {
    href: "/cases",
    label: "업무",
    icon: BriefcaseBusiness,
    permission: "case:read",
  },
  {
    href: "/documents",
    label: "자료",
    icon: Files,
    permission: "document:read",
  },
  {
    href: "/reviews",
    label: "검토",
    icon: BadgeCheck,
    permission: "workpaper:review",
  },
  {
    href: "/assistant",
    label: "AI 파트너",
    icon: Bot,
    permission: "assistant:run",
  },
];

function isCurrent(pathname: string, href: string) {
  if (href === "/") return pathname === href;
  return pathname.startsWith(href);
}

export function MobileBottomNavigation({
  pathname,
  permissions,
}: {
  pathname: string;
  permissions: Permission[];
}) {
  return (
    <nav className="mobile-bottom-navigation" aria-label="모바일 주요 메뉴">
      {items
        .filter(
          (item) => !item.permission || permissions.includes(item.permission),
        )
        .map((item) => {
          const active = isCurrent(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              className={clsx(
                "mobile-bottom-navigation-item",
                active && "mobile-bottom-navigation-item-active",
              )}
              href={item.href}
              aria-current={active ? "page" : undefined}
              key={item.href}
            >
              <Icon size={19} strokeWidth={1.9} aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          );
        })}
    </nav>
  );
}
