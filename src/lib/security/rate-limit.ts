import "server-only";

import { createHash } from "node:crypto";
import { withTenantSql } from "@/lib/db/client";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export class RateLimitError extends Error {
  readonly status = 429;
  readonly code = "RATE_LIMITED";

  constructor(readonly retryAfterSeconds: number) {
    super("요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.");
    this.name = "RateLimitError";
  }
}

export async function rateLimit(
  key: string,
  limit = 12,
  windowMs = 60_000,
  tenantId?: string,
) {
  if (process.env.DATABASE_URL) {
    if (!tenantId)
      throw new Error("tenantId is required for shared rate limits");
    const keyHash = createHash("sha256").update(key).digest("hex");
    const bucket = await withTenantSql(tenantId, async (transaction) => {
      const rows = await transaction<
        Array<{ count: number; window_started_at: Date }>
      >`
        INSERT INTO rate_limit_buckets (
          tenant_id, key_hash, window_started_at, count, updated_at
        ) VALUES (${tenantId}, ${keyHash}, now(), 1, now())
        ON CONFLICT (tenant_id, key_hash) DO UPDATE
        SET count = CASE
              WHEN rate_limit_buckets.window_started_at
                   + (${windowMs} * interval '1 millisecond') <= now()
                THEN 1
              ELSE rate_limit_buckets.count + 1
            END,
            window_started_at = CASE
              WHEN rate_limit_buckets.window_started_at
                   + (${windowMs} * interval '1 millisecond') <= now()
                THEN now()
              ELSE rate_limit_buckets.window_started_at
            END,
            updated_at = now()
        RETURNING count, window_started_at
      `;
      return rows[0];
    });
    if (!bucket) throw new Error("Rate limit bucket was not created");
    if (bucket.count > limit) {
      throw new RateLimitError(
        Math.max(
          1,
          Math.ceil(
            (bucket.window_started_at.getTime() + windowMs - Date.now()) /
              1_000,
          ),
        ),
      );
    }
    return;
  }

  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new RateLimitError(
      Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
    );
  }
  bucket.count += 1;
}
