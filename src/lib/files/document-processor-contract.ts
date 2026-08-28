import { createHash } from "node:crypto";
import { z } from "zod";

export const processorResponseSchema = z.strictObject({
  sourceObjectVersionId: z.string().min(1).max(1024),
  sourceObjectEtag: z.string().min(1).max(200),
  computedSourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  complete: z.literal(true),
  chunks: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(12_000),
        page: z.number().int().positive().optional(),
        section: z.string().max(300).optional(),
        jurisdiction: z
          .string()
          .regex(/^[A-Z]{2,8}$/)
          .default("KR"),
        effectiveFrom: z.iso.datetime({ offset: true }).optional(),
        effectiveTo: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .min(1)
    .max(500),
});

function permanentError(message: string) {
  return Object.assign(new Error(message), { permanent: true });
}

export async function readBoundedProcessorResponse(
  response: Response,
  maximumBytes = 8 * 1024 * 1024,
) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw permanentError("Document processor response exceeds the size limit");
  }
  if (!response.body) {
    throw permanentError("Document processor returned an empty response");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw permanentError(
        "Document processor response exceeds the size limit",
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw permanentError("Document processor returned invalid JSON");
  }
}

export function verifyProcessorResponse(input: {
  response: unknown;
  bytes: Uint8Array;
  expectedVersionId: string;
  expectedEtag: string;
  expectedChecksumSha256: string;
}) {
  const parsed = processorResponseSchema.parse(input.response);
  const locallyComputedChecksum = createHash("sha256")
    .update(input.bytes)
    .digest("hex");
  if (
    parsed.sourceObjectVersionId !== input.expectedVersionId ||
    parsed.sourceObjectEtag !== input.expectedEtag ||
    parsed.computedSourceChecksumSha256 !== locallyComputedChecksum ||
    locallyComputedChecksum !== input.expectedChecksumSha256
  ) {
    throw permanentError(
      "Document processor response is bound to a different source object",
    );
  }
  return parsed;
}
