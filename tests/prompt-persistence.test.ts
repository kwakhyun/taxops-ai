import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAX_MEMO_PROMPT_ID,
  resolveTaxMemoPrompt,
  taxMemoPromptAssets,
} from "@/lib/ai/prompts/tax-memo.v1";

const sqlLiteral = (value: string) =>
  `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\n", "\\n")}'`;
const readSql = (name: string) =>
  readFileSync(new URL(`../drizzle/${name}`, import.meta.url), "utf8");

describe("prompt persistence assets without a running database", () => {
  it("seeds every immutable prompt and activates only the code default", () => {
    const seed = readSql("seed.sql");
    expect([...seed.matchAll(/\n  'tax-memo',\n/g)]).toHaveLength(
      taxMemoPromptAssets.length,
    );
    for (const prompt of taxMemoPromptAssets) {
      expect(seed).toContain(
        [
          `  '${prompt.version}',`,
          `  '${prompt.contentHash}',`,
          `  ${sqlLiteral(prompt.content)},`,
          `  ${prompt.id === DEFAULT_TAX_MEMO_PROMPT_ID},`,
        ].join("\n"),
      );
    }
  });

  it("registers all prompt bodies in the migration journal before seeding", () => {
    const journal = JSON.parse(readSql("meta/_journal.json")) as {
      entries: Array<{ tag: string }>;
    };
    const migrations = journal.entries.map((entry) =>
      readSql(`${entry.tag}.sql`),
    );
    for (const prompt of taxMemoPromptAssets) {
      expect(
        migrations.some(
          (sql) =>
            sql.includes(`'${prompt.version}'`) &&
            sql.includes(`'${prompt.contentHash}'`) &&
            sql.includes(sqlLiteral(prompt.content)),
        ),
      ).toBe(true);
    }

    const current = resolveTaxMemoPrompt(DEFAULT_TAX_MEMO_PROMPT_ID);
    const latestPromptMigration = migrations
      .filter((sql) => sql.includes('INSERT INTO "prompt_versions"'))
      .at(-1);
    expect(latestPromptMigration).toContain(
      `SET "is_active" = ("version" = '${current.version}')`,
    );
    expect(latestPromptMigration).toContain(
      'ON CONFLICT ("name", "version") DO NOTHING',
    );
    expect(latestPromptMigration).toContain("RAISE EXCEPTION");
  });
});
