import { describe, expect, it } from "vitest";
import { assertStoredObjectChecksum } from "@/lib/files/object-storage";

describe("stored object integrity", () => {
  const checksumHex = "ab".repeat(32);
  const checksumBase64 = Buffer.from(checksumHex, "hex").toString("base64");

  it("accepts the exact SHA-256 checksum returned by object storage", () => {
    expect(() =>
      assertStoredObjectChecksum(checksumHex, checksumBase64),
    ).not.toThrow();
  });

  it("fails closed when object storage omits checksum metadata", () => {
    expect(() => assertStoredObjectChecksum(checksumHex, undefined)).toThrow(
      /missing its SHA-256 checksum/,
    );
  });

  it("rejects a checksum that differs from the document binding", () => {
    expect(() =>
      assertStoredObjectChecksum(
        checksumHex,
        Buffer.from("mismatch").toString("base64"),
      ),
    ).toThrow(/does not match/);
  });
});
