"use client";

import { MoveHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Keep dense tables scrollable without hiding the remaining columns from users. */
export function TableViewport({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const measure = () =>
      setOverflowing(viewport.scrollWidth > viewport.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (viewport.firstElementChild)
      observer.observe(viewport.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div className="table-scroll-hint" hidden={!overflowing}>
        <MoveHorizontal size={14} aria-hidden="true" />
        좌우로 스크롤하면 모든 항목을 볼 수 있습니다.
      </div>
      <div
        ref={ref}
        className="table-wrap"
        role="region"
        aria-label={label}
        tabIndex={overflowing ? 0 : undefined}
      >
        {children}
      </div>
    </>
  );
}
