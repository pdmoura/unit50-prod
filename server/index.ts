import { existsSync } from "node:fs";
import { createApp } from "./app.js";
import { authConfig } from "./auth.js";
import { databaseUrl, describeDatabase, devMode } from "./db.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const url = databaseUrl(),
  auth = authConfig(),
  // Hosting platforms (Render, Railway) route traffic to all interfaces; a
  // computer serves only itself. HOST overrides both, for example on a VPS.
  host =
    process.env.HOST ||
    (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT
      ? "0.0.0.0"
      : "127.0.0.1");
if (!auth && !["127.0.0.1", "localhost", "::1"].includes(host))
  throw new Error(
    "Refusing to listen on a public address without sign-in. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.",
  );
const app = await createApp({ logger: true, databaseUrl: url, auth });
app.log.info(
  `Database: ${describeDatabase(url)} (${devMode() ? "DATABASE_URL_DEV, --dev" : "DATABASE_URL"})`,
);
app.log.info(
  auth ? `Sign-in: ${new URL(auth.url).host}` : "Sign-in: off (local only)",
);
await app.listen({ host, port: Number(process.env.PORT || 3000) });
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.on(event, () => {
    void app.close().then(() => process.exit(0));
  });
