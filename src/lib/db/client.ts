import "server-only";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let client: ReturnType<typeof postgres> | undefined;
let reviewClient: ReturnType<typeof postgres> | undefined;

export function getSqlClient() {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is required outside demo repository mode");

  client ??= postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return client;
}

export async function closeSqlClient() {
  const activeClient = client;
  const activeReviewClient = reviewClient;
  client = undefined;
  reviewClient = undefined;
  await Promise.all([
    activeClient?.end({ timeout: 2 }),
    activeReviewClient?.end({ timeout: 2 }),
  ]);
}

export function getReviewSqlClient() {
  const url = process.env.REVIEW_DATABASE_URL;
  if (!url)
    throw new Error("REVIEW_DATABASE_URL is required for review decisions");
  reviewClient ??= postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return reviewClient;
}

export async function withReviewerTenantSql<T>(
  tenantId: string,
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
) {
  return getReviewSqlClient().begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return operation(transaction);
  });
}

export function getDatabase() {
  return drizzle(getSqlClient(), { schema });
}

export async function withTenantSql<T>(
  tenantId: string,
  operation: (transaction: postgres.TransactionSql) => Promise<T>,
) {
  return getSqlClient().begin(async (transaction) => {
    await transaction`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return operation(transaction);
  });
}

export async function withTenantTransaction<T>(
  tenantId: string,
  operation: (
    transaction: Parameters<
      Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]
    >[0],
  ) => Promise<T>,
) {
  const db = getDatabase();
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return operation(transaction);
  });
}
