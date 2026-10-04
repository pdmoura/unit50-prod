import { existsSync } from "node:fs";
import { createApp } from "./app.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const app = await createApp({ logger: true });
await app.listen({ host: "127.0.0.1", port: Number(process.env.PORT || 3000) });
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.on(event, () => {
    void app.close().then(() => process.exit(0));
  });
