import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readBoundedProcessorResponse,
  verifyProcessorResponse,
} from "@/lib/files/document-processor-contract";

const bytes = new TextEncoder().encode("version-bound tax evidence");
const checksum = createHash("sha256").update(bytes).digest("hex");
const validResponse = {
  sourceObjectVersionId: "version-7",
  sourceObjectEtag: '"etag-7"',
  computedSourceChecksumSha256: checksum,
  complete: true as const,
  chunks: [{ text: "검증된 세무 증빙", jurisdiction: "KR" }],
};

describe("document processor source binding", () => {
  it("accepts only a response bound to the exact downloaded object bytes", () => {
    expect(
      verifyProcessorResponse({
        response: validResponse,
        bytes,
        expectedVersionId: "version-7",
        expectedEtag: '"etag-7"',
        expectedChecksumSha256: checksum,
      }).chunks,
    ).toHaveLength(1);
  });

  it("uses one-based page numbers and omits the page for non-paginated data", () => {
    const oneBased = verifyProcessorResponse({
      response: {
        ...validResponse,
        chunks: [{ ...validResponse.chunks[0], page: 1 }],
      },
      bytes,
      expectedVersionId: "version-7",
      expectedEtag: '"etag-7"',
      expectedChecksumSha256: checksum,
    });
    expect(oneBased.chunks[0]?.page).toBe(1);
    expect(() =>
      verifyProcessorResponse({
        response: {
          ...validResponse,
          chunks: [{ ...validResponse.chunks[0], page: 0 }],
        },
        bytes,
        expectedVersionId: "version-7",
        expectedEtag: '"etag-7"',
        expectedChecksumSha256: checksum,
      }),
    ).toThrow();
  });

  it.each([
    ["version", { ...validResponse, sourceObjectVersionId: "version-latest" }],
    ["etag", { ...validResponse, sourceObjectEtag: '"etag-latest"' }],
    [
      "checksum",
      { ...validResponse, computedSourceChecksumSha256: "0".repeat(64) },
    ],
  ])("rejects a mismatched %s", (_field, response) => {
    expect(() =>
      verifyProcessorResponse({
        response,
        bytes,
        expectedVersionId: "version-7",
        expectedEtag: '"etag-7"',
        expectedChecksumSha256: checksum,
      }),
    ).toThrow("different source object");
  });

  it("rejects an oversized response even when Content-Length is absent", async () => {
    const response = new Response("x".repeat(65), {
      headers: { "content-type": "application/json" },
    });
    await expect(readBoundedProcessorResponse(response, 64)).rejects.toThrow(
      "size limit",
    );
  });
});
