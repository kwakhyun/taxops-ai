import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { connect } from "node:net";
import { chunkPlainText, type ParsedChunk } from "../lib/files/chunking.ts";
import {
  readBoundedProcessorResponse,
  verifyProcessorResponse,
} from "../lib/files/document-processor-contract.ts";
import { validateRegionalServiceEndpoint } from "../lib/security/regional-service.ts";
import { fetchWithoutRedirect } from "../lib/security/safe-fetch.ts";
import type { TenantAiPolicy } from "../lib/security/ai-policy.ts";
import { MalwareDetectedError, type SourceDocument } from "./contracts.ts";
import { getS3Client, parseS3Uri } from "./object-storage-client.ts";

export async function scanWithClamAv(bytes: Uint8Array) {
  const host = process.env.CLAMAV_HOST;
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  if (!host) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("CLAMAV_HOST is required in production"), {
        permanent: true,
      });
    }
    return;
  }

  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    const responseChunks: Buffer[] = [];
    const timeout = setTimeout(
      () => socket.destroy(new Error("ClamAV scan timed out")),
      15_000,
    );
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.slice(
          offset,
          Math.min(offset + 64 * 1024, bytes.length),
        );
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.end(Buffer.alloc(4));
    });
    socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(
        Buffer.concat(responseChunks)
          .toString("utf8")
          .replace(/\0/g, "")
          .trim(),
      );
    });
  });
  if (!response.endsWith("OK")) {
    throw new MalwareDetectedError();
  }
}

export async function parseDocument(
  document: SourceDocument,
  bytes: Uint8Array,
  policy: TenantAiPolicy,
): Promise<ParsedChunk[]> {
  if (
    document.source_type === "BUSINESS_RECORD" &&
    (document.mime_type === "text/plain" || document.mime_type === "text/csv")
  ) {
    return chunkPlainText(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).map((chunk) => ({
      ...chunk,
      sourceType: document.source_type,
      jurisdiction: "KR",
    }));
  }

  const processorUrl = process.env.DOCUMENT_PROCESSOR_URL;
  if (!processorUrl) {
    throw Object.assign(
      new Error("DOCUMENT_PROCESSOR_URL is required for this file type"),
      { permanent: true },
    );
  }
  const url = validateRegionalServiceEndpoint({
    serviceName: "Document processor",
    url: processorUrl,
    token: process.env.DOCUMENT_PROCESSOR_TOKEN,
    dataRegion: process.env.DOCUMENT_PROCESSOR_DATA_REGION,
    allowedHosts: process.env.DOCUMENT_PROCESSOR_ALLOWED_HOSTS,
    policy,
    production: process.env.NODE_ENV === "production",
  });
  if (
    !document.object_version_id ||
    !document.object_etag ||
    document.object_checksum_sha256 !== document.checksum_sha256
  ) {
    throw Object.assign(
      new Error("Document processor requires an immutable object binding"),
      { permanent: true },
    );
  }
  const { bucket, key } = parseS3Uri(document.object_key);
  const downloadExpiresInSeconds = 300;
  const versionedDownloadUrl = await getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      VersionId: document.object_version_id,
      ChecksumMode: "ENABLED",
    }),
    { expiresIn: downloadExpiresInSeconds },
  );
  const response = await fetchWithoutRedirect(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.DOCUMENT_PROCESSOR_TOKEN
        ? { Authorization: `Bearer ${process.env.DOCUMENT_PROCESSOR_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      sourceObject: {
        uri: document.object_key,
        versionId: document.object_version_id,
        etag: document.object_etag,
        checksumSha256: document.checksum_sha256,
        downloadUrl: versionedDownloadUrl,
        downloadUrlExpiresInSeconds: downloadExpiresInSeconds,
      },
      mimeType: document.mime_type,
      sourceType: document.source_type,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Document processor failed with ${response.status}`);
  }
  const parsed = verifyProcessorResponse({
    response: await readBoundedProcessorResponse(response),
    bytes,
    expectedVersionId: document.object_version_id,
    expectedEtag: document.object_etag,
    expectedChecksumSha256: document.checksum_sha256,
  });
  return parsed.chunks.map((chunk) => {
    if (document.source_type !== "BUSINESS_RECORD" && !chunk.effectiveFrom) {
      throw Object.assign(
        new Error("Dated authority and policy chunks require effectiveFrom"),
        { permanent: true },
      );
    }
    if (
      chunk.effectiveFrom &&
      chunk.effectiveTo &&
      new Date(chunk.effectiveTo) <= new Date(chunk.effectiveFrom)
    ) {
      throw Object.assign(new Error("Chunk effective range is invalid"), {
        permanent: true,
      });
    }
    return { ...chunk, sourceType: document.source_type };
  });
}
