import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import { runImport } from "../server/importer.js";
import { feature, source } from "./fixtures.js";
import {
  TEST_DATABASE_URL,
  createSchema,
  dropSchema,
  startImport,
} from "./helpers.js";
// Browser tests run against a private schema with synthetic parcels, never the app's data.
const schema = await createSchema();
const app = await createApp({
  databaseUrl: TEST_DATABASE_URL,
  schema,
  allowImports: false,
  cloudinary: null,
  auth: null,
});
const sql = openDb(TEST_DATABASE_URL, schema);
await startImport(sql, "test");
await runImport(sql, "test", source([feature(), feature(2, "000000002")]));
await sql.end();
console.log("Browser tests use isolated synthetic fixtures.");
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await dropSchema(schema);
  process.exit(0);
}
// Only this disposable test server exposes shutdown; production has no such route.
app.post("/__test/shutdown", async () => {
  setTimeout(() => void shutdown(), 100);
  return { ok: true };
});
await app.listen({ host: "127.0.0.1", port: 3100 });
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => void shutdown());
