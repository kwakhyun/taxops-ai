export function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function formatMilliseconds(value: number) {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(1)}초`;
}

export function formatWon(value: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(value);
}
