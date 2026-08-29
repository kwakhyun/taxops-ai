import { createServer } from "node:http";
import {
  openReviewServiceEnvelope,
  reviewServiceContext,
} from "../lib/review/service-crypto.ts";
import {
  evidenceSchema,
  tokenRequestSchema,
  workpaperSchema,
  type EvidenceInput,
  type TokenRequestInput,
  type WorkpaperInput,
} from "./contracts.ts";
import {
  logReviewEvent,
  readRequestBody,
  requestMetadata,
  writeEncryptedResponse,
  type RequestMetadata,
} from "./http-transport.ts";

type ReviewHandlerResult = Record<string, unknown> | undefined;

export function createReviewerHttpServer(input: {
  sharedSecret: string;
  healthCheck: () => Promise<void>;
  issueWorkpaperTokens: (
    value: TokenRequestInput,
  ) => Promise<ReviewHandlerResult>;
  decideWorkpaper: (value: WorkpaperInput) => Promise<ReviewHandlerResult>;
  decideEvidence: (value: EvidenceInput) => Promise<ReviewHandlerResult>;
}) {
  return createServer(async (request, target) => {
    const requestUrl = new URL(request.url ?? "/", "http://reviewer.internal");
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      try {
        await input.healthCheck();
        target.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        target.end('{"status":"ready"}');
      } catch {
        target.writeHead(503, { "content-type": "application/json" });
        target.end('{"status":"unavailable"}');
      }
      return;
    }
    if (
      request.method !== "POST" ||
      ![
        "/v1/tokens/workpapers",
        "/v1/decisions/workpapers",
        "/v1/decisions/evidence",
      ].includes(requestUrl.pathname) ||
      requestUrl.search
    ) {
      target.writeHead(404, { "content-type": "application/json" });
      target.end('{"error":"not_found"}');
      return;
    }

    let metadata: RequestMetadata | undefined;
    try {
      if (
        request.headers["content-type"] !==
        "application/vnd.taxops.encrypted+json"
      ) {
        throw new Error("CONTENT_TYPE_INVALID");
      }
      metadata = requestMetadata(request, requestUrl.pathname);
      const encrypted = await readRequestBody(request);
      const opened = openReviewServiceEnvelope(
        input.sharedSecret,
        encrypted,
        reviewServiceContext({ ...metadata, direction: "request" }),
      );
      const result =
        requestUrl.pathname === "/v1/tokens/workpapers"
          ? await input.issueWorkpaperTokens(tokenRequestSchema.parse(opened))
          : requestUrl.pathname === "/v1/decisions/workpapers"
            ? await input.decideWorkpaper(workpaperSchema.parse(opened))
            : await input.decideEvidence(evidenceSchema.parse(opened));
      if (!result) {
        writeEncryptedResponse(
          target,
          409,
          { ok: false, code: "DECISION_CONFLICT" },
          metadata,
          input.sharedSecret,
        );
        return;
      }
      logReviewEvent("review.decision_succeeded", {
        tenantId: (opened as { expectedActor: { tenantId: string } })
          .expectedActor.tenantId,
        actorId: (opened as { expectedActor: { id: string } }).expectedActor.id,
        targetType: requestUrl.pathname.endsWith("workpapers")
          ? "workpaper"
          : "document",
        outcome: "SUCCESS",
      });
      writeEncryptedResponse(target, 200, result, metadata, input.sharedSecret);
    } catch (error) {
      logReviewEvent("review.decision_failed", {
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
        outcome: "FAILED",
      });
      if (metadata) {
        writeEncryptedResponse(
          target,
          400,
          { ok: false, code: "REQUEST_REJECTED" },
          metadata,
          input.sharedSecret,
        );
      } else {
        target.writeHead(400, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        target.end('{"error":"request_rejected"}');
      }
    }
  });
}
