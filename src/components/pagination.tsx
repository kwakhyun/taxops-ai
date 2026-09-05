"use client";

export function Pagination({
  page,
  pageSize,
  total,
  disabled,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  disabled?: boolean;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label="목록 페이지">
      <button
        type="button"
        className="button button-secondary button-compact"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        이전 페이지
      </button>
      <span role="status">
        {page} / {pages}페이지 · 전체 {total}건
      </span>
      <button
        type="button"
        className="button button-secondary button-compact"
        disabled={disabled || page >= pages}
        onClick={() => onPageChange(page + 1)}
      >
        다음 페이지
      </button>
    </nav>
  );
}
