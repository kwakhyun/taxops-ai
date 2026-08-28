export type ParsedChunk = {
  text: string;
  sourceType?: "BUSINESS_RECORD" | "TAX_AUTHORITY" | "INTERNAL_POLICY";
  jurisdiction?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  page?: number;
  section?: string;
  charStart?: number;
  charEnd?: number;
};

export class DocumentChunkLimitError extends Error {
  readonly permanent = true;
  readonly code = "DOCUMENT_CHUNK_LIMIT_EXCEEDED";

  constructor() {
    super(
      "문서 전체를 허용된 청크 수 안에 인덱싱할 수 없습니다. 파일을 분할한 뒤 다시 업로드해 주세요.",
    );
    this.name = "DocumentChunkLimitError";
  }
}

export function chunkPlainText(
  text: string,
  options: { maximum?: number; overlap?: number; maxChunks?: number } = {},
) {
  const normalized = text.normalize("NFKC").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    throw Object.assign(new Error("Document has no extractable text"), {
      permanent: true,
    });
  }
  const maximum = options.maximum ?? 1_200;
  const overlap = options.overlap ?? 120;
  const maxChunks = options.maxChunks ?? 500;
  if (maximum < 100 || overlap < 0 || overlap >= maximum || maxChunks < 1) {
    throw new Error("Invalid chunking options");
  }

  const chunks: ParsedChunk[] = [];
  let coveredEnd = 0;
  for (let start = 0; start < normalized.length && chunks.length < maxChunks;) {
    const proposedEnd = Math.min(start + maximum, normalized.length);
    const paragraphEnd = normalized.lastIndexOf("\n", proposedEnd);
    const end =
      paragraphEnd > start + Math.min(400, maximum / 2)
        ? paragraphEnd
        : proposedEnd;
    const value = normalized.slice(start, end).trim();
    if (value) {
      chunks.push({
        text: value,
        section: `문자 ${start}-${end}`,
        charStart: start,
        charEnd: end,
      });
    }
    coveredEnd = end;
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  if (coveredEnd < normalized.length) throw new DocumentChunkLimitError();
  return chunks;
}
