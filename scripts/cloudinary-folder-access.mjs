// One-time setup: gives the app's restricted Cloudinary API key the Manager
// role on one folder (view, add, edit and delete assets, create subfolders,
// manage the folder's access) through the Admin API folder_operations endpoint.
//
//   node scripts/cloudinary-folder-access.mjs [folder]      (default: unit50-uploads)
//
// Reads from the environment (and from .env when present):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY           the restricted key that RECEIVES the role
//   CLOUDINARY_ADMIN_API_KEY     an admin key that performs the grant
//   CLOUDINARY_ADMIN_API_SECRET  (set these two only for this run; keep them out of .env)
//
// Optional: CLOUDINARY_FOLDER_ROLE to force a specific role ID.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = process.env,
  folder = (
    process.argv[2] ||
    env.CLOUDINARY_FOLDER ||
    "unit50-uploads"
  ).replace(/^\/+|\/+$/g, "");
const missing = [
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_ADMIN_API_KEY",
  "CLOUDINARY_ADMIN_API_SECRET",
].filter((name) => !env[name]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  console.error(
    "A restricted key cannot grant itself access, so an admin key and secret are needed for this one run.",
  );
  process.exit(1);
}
const base = `https://api.cloudinary.com/v1_1/${encodeURIComponent(env.CLOUDINARY_CLOUD_NAME)}`,
  authorization = `Basic ${Buffer.from(`${env.CLOUDINARY_ADMIN_API_KEY}:${env.CLOUDINARY_ADMIN_API_SECRET}`).toString("base64")}`,
  principal = { id: env.CLOUDINARY_API_KEY, type: "apiKey" },
  masked = `…${env.CLOUDINARY_API_KEY.slice(-4)}`;
// Cloudinary's docs show both ID prefixes for folder roles, so both are tried.
const roleCandidates = env.CLOUDINARY_FOLDER_ROLE
  ? [env.CLOUDINARY_FOLDER_ROLE]
  : ["cld::role::folder::manager", "cld::role::content::folder::manager"];

async function call(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: authorization,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data.error?.message || `Cloudinary returned HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return data;
}
// external_id is the folder's permanent identifier; it is listed by its parent.
async function externalId(path) {
  const parent = path.split("/").slice(0, -1).join("/"),
    list = parent
      ? `/folders/${parent.split("/").map(encodeURIComponent).join("/")}`
      : "/folders";
  let cursor;
  do {
    const query = new URLSearchParams({
      max_results: "500",
      ...(cursor ? { next_cursor: cursor } : {}),
    });
    const page = await call(`${list}?${query}`);
    const match = (page.folders || []).find((f) => f.path === path);
    if (match) return match.external_id;
    cursor = page.next_cursor;
  } while (cursor);
  throw new Error(
    `Folder "${path}" was not found in cloud "${env.CLOUDINARY_CLOUD_NAME}".`,
  );
}
async function rolesOf(id) {
  const shared =
    (await call(`/folder_operations/invite/${id}`)).shared_with || [];
  return shared
    .filter((s) => s.type === "apiKey" && s.id === principal.id)
    .flatMap((s) => s.roles || []);
}

try {
  const id = await externalId(folder);
  console.log(`Folder "${folder}" found.`);
  let roles = await rolesOf(id);
  if (roles.some((r) => roleCandidates.includes(r.id))) {
    console.log(
      `API key ${masked} already has: ${roles.map((r) => r.name || r.id).join(", ")}. Nothing to do.`,
    );
    process.exit(0);
  }
  let granted, lastError;
  for (const role of roleCandidates) {
    try {
      await call(`/folder_operations/invite/${id}`, {
        principal,
        operation: "add",
        roles: [role],
      });
      granted = role;
      break;
    } catch (error) {
      // 401/403 mean the admin key itself was refused, so another role ID will not help.
      if (error.status === 401 || error.status === 403) throw error;
      lastError = error;
    }
  }
  if (!granted) throw lastError;
  roles = await rolesOf(id);
  if (!roles.some((r) => roleCandidates.includes(r.id)))
    throw new Error(
      `Cloudinary accepted ${granted} but does not list it on the folder. Check the folder's sharing settings.`,
    );
  console.log(`Granted ${granted} to API key ${masked} on "${folder}".`);
  console.log(
    `Roles now on this folder for the key: ${roles.map((r) => r.name || r.id).join(", ")}`,
  );
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
}
