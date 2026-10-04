import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { openDb, migrate, type Db } from "../server/db.js";

if (existsSync(".env")) process.loadEnvFile(".env");
// Tests never touch the app's own tables: each one gets a private schema in
// the test database (the local docker-compose one unless TEST_DATABASE_URL is set).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgres://unit50:unit50@127.0.0.1:54350/unit50_test";

export async function createSchema() {
  const schema = `t_${randomUUID().replaceAll("-", "")}`,
    admin = openDb(TEST_DATABASE_URL);
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  await admin.end();
  return schema;
}
export async function dropSchema(schema: string) {
  if (!/^t_[0-9a-f]{32}$/.test(schema))
    throw new Error("Unexpected test schema");
  const admin = openDb(TEST_DATABASE_URL);
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
// Runs fn against an empty, migrated database and removes it afterwards.
export async function withDb(fn: (sql: Db, schema: string) => Promise<void>) {
  const schema = await createSchema(),
    sql = openDb(TEST_DATABASE_URL, schema);
  try {
    await migrate(sql);
    await fn(sql, schema);
  } finally {
    await sql.end();
    await dropSchema(schema);
  }
}
export const startImport = (sql: Db, id: string) =>
  sql`INSERT INTO imports (id, state, started_at) VALUES (${id}, 'running', ${new Date().toISOString()})`;
