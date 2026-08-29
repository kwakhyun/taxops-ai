export interface DocumentDownloadDescriptor {
  name: string;
  mimeType: string;
  objectKey?: string;
  objectVersionId?: string;
  objectChecksumSha256?: string;
  demoBytes?: Uint8Array;
}

export function attachmentContentDisposition(filename: string) {
  const fallback =
    filename
      .normalize("NFKC")
      .replaceAll(/[\r\n"\\/]/g, "_")
      .replaceAll(/[^\x20-\x7E]/g, "_")
      .slice(0, 120) || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
