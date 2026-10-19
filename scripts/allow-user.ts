// Lets a person use Unit 50, or takes that away. Signing in is handled by
// Supabase Auth (create the account in the Supabase dashboard: Authentication >
// Users > Add user, with "Auto Confirm User" ticked); this decides who gets in.
// Admins can do the same, and choose each rep's modules, under Team & access.
//
//   npx tsx scripts/allow-user.ts <email>            production (DATABASE_URL), as a rep
//   npx tsx scripts/allow-user.ts <email> --admin    as an admin (or makes them one)
//   npx tsx scripts/allow-user.ts <email> --rep      makes an admin a rep again
//   npx tsx scripts/allow-user.ts <email> --super-admin      the owner: also runs county
//                                                            imports (Data & imports)
//   npx tsx scripts/allow-user.ts <email> --no-super-admin   takes that away (stays admin)
//
// Super admin can only be given or taken here, never from the app.
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
  superAdmin = args.includes("--super-admin")
    ? true
    : args.includes("--no-super-admin")
      ? false
      : null,
  role =
    args.includes("--admin") || superAdmin
      ? "admin"
      : args.includes("--rep")
        ? "rep"
        : null,
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
    if (superAdmin === false && role === "rep")
      throw new Error("Use --no-super-admin first, then --rep.");
    await sql`INSERT INTO app_users (email, role, super_admin) VALUES (${email}, ${role ?? "rep"}, ${superAdmin ?? false}) ON CONFLICT (email) DO UPDATE SET role=COALESCE(${role}, app_users.role), super_admin=COALESCE(${superAdmin}, app_users.super_admin)`;
    console.log(`${email} can use Unit 50 once they have a Supabase login.`);
  } else if (!args.includes("--list"))
    throw new Error("Give an email address, or --list.");
  const people =
    await sql`SELECT email, role, super_admin FROM app_users ORDER BY super_admin DESC, role, email`;
  console.log(
    `Enabled (${people.length}): ${people.map((p) => `${p.email} (${p.superAdmin ? "super admin" : p.role})`).join(", ") || "nobody"}`,
  );
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
