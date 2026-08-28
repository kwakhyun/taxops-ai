import { createHash } from "node:crypto";
import { z } from "zod";
import { detectPromptInjection } from "@/lib/ai/guardrails";
import { normalizeTrustedSourceUri } from "@/lib/security/source-provenance";

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

const allowedFileTypes = {
  "application/pdf": ["pdf"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
} as const;

export const uploadMetadataSchema = z
  .strictObject({
    matterId: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[a-z0-9-]+$/),
    idempotencyKey: z.string().min(12).max(120),
    sourceType: z
      .enum(["BUSINESS_RECORD", "TAX_AUTHORITY", "INTERNAL_POLICY"])
      .default("BUSINESS_RECORD"),
    sourcePublisher: z.string().trim().min(2).max(200).optional(),
    sourceUri: z
      .string()
      .trim()
      .max(2_000)
      .transform((value, context) => {
        try {
          return normalizeTrustedSourceUri(value);
        } catch {
          context.addIssue({
            code: "custom",
            message: "허용된 HTTPS 출처 주소가 필요합니다.",
          });
          return z.NEVER;
        }
      })
      .optional(),
  })
  .superRefine((input, context) => {
    if (
      input.sourcePublisher &&
      detectPromptInjection(input.sourcePublisher.normalize("NFKC"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourcePublisher"],
        message: "발행기관에 안전하지 않은 지시 패턴이 포함되어 있습니다.",
      });
    }
    if (input.sourceType !== "TAX_AUTHORITY") return;
    if (!input.sourcePublisher) {
      context.addIssue({
        code: "custom",
        path: ["sourcePublisher"],
        message: "공식 자료의 발행기관이 필요합니다.",
      });
    }
    if (!input.sourceUri) {
      context.addIssue({
        code: "custom",
        path: ["sourceUri"],
        message: "공식 자료의 허용된 HTTPS 원문 주소가 필요합니다.",
      });
    }
  });

export class FileValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "EMPTY_FILE"
      | "FILE_TOO_LARGE"
      | "UNSUPPORTED_TYPE"
      | "EXTENSION_MISMATCH"
      | "INVALID_SIGNATURE"
      | "INVALID_ARCHIVE"
      | "ARCHIVE_LIMIT_EXCEEDED"
      | "UNSAFE_FILENAME",
  ) {
    super(message);
    this.name = "FileValidationError";
  }
}

export function normalizeFilename(filename: string) {
  const normalized = filename
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new FileValidationError(
      "안전하지 않은 파일명입니다.",
      "UNSAFE_FILENAME",
    );
  }
  return normalized.slice(0, 180);
}

function inspectOoxmlArchive(mime: string, bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  const searchStart = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (
    let offset = bytes.length - minimumEocd;
    offset >= searchStart;
    offset--
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) {
    throw new FileValidationError(
      "OOXML ZIP 디렉터리를 확인할 수 없습니다.",
      "INVALID_ARCHIVE",
    );
  }
  const entryCount = view.getUint16(eocd + 10, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (
    view.getUint16(eocd + 4, true) !== 0 ||
    view.getUint16(eocd + 6, true) !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0 ||
    entryCount > 2_000 ||
    centralOffset + centralSize !== eocd ||
    eocd + minimumEocd + commentLength !== bytes.length
  ) {
    throw new FileValidationError(
      "OOXML ZIP 구조 또는 항목 수가 안전 한도를 벗어났습니다.",
      "ARCHIVE_LIMIT_EXCEEDED",
    );
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set<string>();
  const localOffsets = new Set<number>();
  const occupiedRanges: Array<{ start: number; end: number }> = [];
  let offset = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new FileValidationError(
        "OOXML ZIP 중앙 디렉터리가 손상되었습니다.",
        "INVALID_ARCHIVE",
      );
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localOffset = view.getUint32(offset + 42, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      flags & 0x9 ||
      ![0, 8].includes(compressionMethod) ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset === 0xffffffff ||
      next > eocd
    ) {
      throw new FileValidationError(
        "암호화 또는 ZIP64 OOXML 파일은 처리할 수 없습니다.",
        "INVALID_ARCHIVE",
      );
    }
    let name: string;
    try {
      name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new FileValidationError(
        "OOXML 내부 경로 인코딩이 올바르지 않습니다.",
        "INVALID_ARCHIVE",
      );
    }
    const normalizedName = name.normalize("NFKC");
    const pathSegments = normalizedName.split("/");
    const directoryEntry = normalizedName.endsWith("/");
    const pathSegmentsWithoutTrailingDirectory = directoryEntry
      ? pathSegments.slice(0, -1)
      : pathSegments;
    const normalizedPathKey = normalizedName
      .replace(/\/$/, "")
      .toLocaleLowerCase("en-US");
    if (
      !normalizedName ||
      normalizedName.length > 1_024 ||
      normalizedName.startsWith("/") ||
      /[\\:\u0000-\u001f\u007f]/u.test(normalizedName) ||
      pathSegmentsWithoutTrailingDirectory.some(
        (segment) => !segment || segment === "." || segment === "..",
      ) ||
      names.has(normalizedPathKey)
    ) {
      throw new FileValidationError(
        "OOXML 내부 경로가 안전하지 않습니다.",
        "INVALID_ARCHIVE",
      );
    }
    const unixMode = externalAttributes >>> 16;
    const unixFileType = unixMode & 0o170000;
    if (
      ![0, 0o040000, 0o100000].includes(unixFileType) ||
      (unixFileType === 0o040000 && !directoryEntry)
    ) {
      throw new FileValidationError(
        "OOXML 내부 링크 또는 특수 파일은 처리할 수 없습니다.",
        "INVALID_ARCHIVE",
      );
    }
    if (
      localOffsets.has(localOffset) ||
      localOffset + 30 > centralOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new FileValidationError(
        "OOXML ZIP 로컬 헤더가 손상되었습니다.",
        "INVALID_ARCHIVE",
      );
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localCompressionMethod = view.getUint16(localOffset + 8, true);
    const localCrc32 = view.getUint32(localOffset + 14, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localUncompressed = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localDataStart = localNameStart + localNameLength + localExtraLength;
    const localDataEnd = localDataStart + compressed;
    const centralNameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    const localNameBytes = bytes.slice(
      localNameStart,
      localNameStart + localNameLength,
    );
    if (
      localFlags !== flags ||
      localCompressionMethod !== compressionMethod ||
      localCrc32 !== crc32 ||
      localCompressed !== compressed ||
      localUncompressed !== uncompressed ||
      localNameLength !== nameLength ||
      localDataEnd > centralOffset ||
      centralNameBytes.length !== localNameBytes.length ||
      centralNameBytes.some(
        (byte, byteIndex) => byte !== localNameBytes[byteIndex],
      ) ||
      occupiedRanges.some(
        (range) => localOffset < range.end && localDataEnd > range.start,
      )
    ) {
      throw new FileValidationError(
        "OOXML ZIP 중앙·로컬 헤더가 일치하지 않습니다.",
        "INVALID_ARCHIVE",
      );
    }
    names.add(normalizedPathKey);
    localOffsets.add(localOffset);
    occupiedRanges.push({ start: localOffset, end: localDataEnd });
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    offset = next;
  }
  if (offset !== centralOffset + centralSize) {
    throw new FileValidationError(
      "OOXML ZIP 중앙 디렉터리 길이가 일치하지 않습니다.",
      "INVALID_ARCHIVE",
    );
  }
  if (
    totalUncompressed > 100 * 1024 * 1024 ||
    (totalCompressed > 0 && totalUncompressed / totalCompressed > 100)
  ) {
    throw new FileValidationError(
      "압축 해제 크기 또는 압축률이 안전 한도를 초과했습니다.",
      "ARCHIVE_LIMIT_EXCEEDED",
    );
  }
  const documentRoot = mime.includes("spreadsheet")
    ? "xl/workbook.xml"
    : "word/document.xml";
  if (
    !names.has("[content_types].xml") ||
    !names.has("_rels/.rels") ||
    !names.has(documentRoot)
  ) {
    throw new FileValidationError(
      "파일 내용이 선언된 OOXML 형식과 일치하지 않습니다.",
      "INVALID_ARCHIVE",
    );
  }
}

function hasExpectedSignature(mime: string, bytes: Uint8Array) {
  if (mime === "application/pdf") {
    return (
      bytes.length >= 5 &&
      new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-"
    );
  }
  if (mime.includes("openxmlformats")) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    inspectOoxmlArchive(mime, bytes);
    return true;
  }
  return true;
}

export function validateFile(input: {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}) {
  const name = normalizeFilename(input.name);
  if (input.size === 0)
    throw new FileValidationError(
      "빈 파일은 업로드할 수 없습니다.",
      "EMPTY_FILE",
    );
  if (input.size > MAX_FILE_BYTES) {
    throw new FileValidationError(
      "파일당 15 MB 제한을 초과했습니다.",
      "FILE_TOO_LARGE",
    );
  }

  const allowedExtensions =
    allowedFileTypes[input.type as keyof typeof allowedFileTypes];
  if (!allowedExtensions) {
    throw new FileValidationError(
      "지원하지 않는 파일 형식입니다.",
      "UNSUPPORTED_TYPE",
    );
  }

  const extension = name.split(".").pop()?.toLocaleLowerCase("en-US") ?? "";
  if (!(allowedExtensions as readonly string[]).includes(extension)) {
    throw new FileValidationError(
      "파일 확장자와 MIME 유형이 일치하지 않습니다.",
      "EXTENSION_MISMATCH",
    );
  }

  if (!hasExpectedSignature(input.type, input.bytes)) {
    throw new FileValidationError(
      "파일 서명이 MIME 유형과 일치하지 않습니다.",
      "INVALID_SIGNATURE",
    );
  }

  return {
    name,
    mimeType: input.type,
    size: input.size,
    checksum: createHash("sha256").update(input.bytes).digest("hex"),
  };
}
