import { z } from "zod";

export const actorSchema = z.strictObject({
  tenantId: z.uuid(),
  id: z.uuid(),
  name: z.string().trim().min(1).max(120),
});

export const workpaperSchema = z.strictObject({
  identityToken: z.string().min(20).max(20_000),
  expectedActor: actorSchema,
  targetId: z.uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().min(4).max(800),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  traceId: z.string().min(8).max(120),
  approvalToken: z.string().min(20).max(4_000),
});

export const tokenRequestSchema = z.strictObject({
  identityToken: z.string().min(20).max(20_000),
  expectedActor: actorSchema,
  targetId: z.uuid(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const evidenceSchema = z.strictObject({
  identityToken: z.string().min(20).max(20_000),
  expectedActor: actorSchema,
  documentId: z.uuid(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  traceId: z.string().min(8).max(120),
});

export type ActorInput = z.infer<typeof actorSchema>;
export type WorkpaperInput = z.infer<typeof workpaperSchema>;
export type TokenRequestInput = z.infer<typeof tokenRequestSchema>;
export type EvidenceInput = z.infer<typeof evidenceSchema>;
