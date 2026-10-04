// Lets a person use Unit 50, or takes that away. Signing in is handled by
// Supabase Auth (create the account in the Supabase dashboard: Authentication >
// Users > Add user, with "Auto Confirm User" ticked); this decides who gets in.
//
//   npx tsx scripts/allow-user.ts <email>            production (DATABASE_URL)
//   npx tsx scripts/allow-user.ts <email> --dev      local database (DATABASE_URL_DEV)
//   npx tsx scripts/allow-user.ts <email> --remove
//   npx tsx scripts/allow-user.ts --list
import { existsSync } from "node:fs";
import {
  openDb,
  migrate,
  databaseUrl,
  describeDatabase,
} from "../server/db.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2),
  email = args.find((a) => !a.startsWith("--"))?.toLowerCase(),
  url = databaseUrl(),
  sql = openDb(url);
try {
  await migrate(sql);
  console.log(`Database: ${describeDatabase(url)}`);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error(`"${email}" is not an email address.`);
  if (email && args.includes("--remove")) {
    const removed =
      await sql`DELETE FROM app_users WHERE email=${email} RETURNING email`;
    console.log(
      removed.length ? `Removed ${email}.` : `${email} was not enabled.`,
    );
  } else if (email) {
    await sql`INSERT INTO app_users (email) VALUES (${email}) ON CONFLICT DO NOTHING`;
    console.log(`${email} can use Unit 50 once they have a Supabase login.`);
  } else if (!args.includes("--list"))
    throw new Error("Give an email address, or --list.");
  const people = await sql`SELECT email FROM app_users ORDER BY email`;
  console.log(
    `Enabled (${people.length}): ${people.map((p) => p.email).join(", ") || "nobody"}`,
  );
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
