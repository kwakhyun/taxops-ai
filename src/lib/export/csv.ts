export function csvCell(value: string | number) {
  const raw = String(value);
  // Spreadsheet programs must treat user-provided values as text, not formulas.
  const text = /^(?:\s*[=+\-@]|[\t\r\n])/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
