import { MODULES, type Account, type Module } from "../shared/types.js";

// Which part of Unit 50 an API call belongs to. The server checks this on every
// request, so turning a module off for someone takes effect on their next click.
//
// The property panel opens from the map, the follow-up list and the lead board,
// so property work is allowed with any of those three modules. County data
// (imports, Parcel Search fetches, and the Data & imports page) belongs to the
// super admin alone, not to admins.
export type Area = Module | "property" | "admin" | "super-admin" | "signed-in";
const PROPERTY_MODULES: Module[] = ["map", "follow-ups", "leads"];

export function areaFor(method: string, path: string): Area {
  if (path.startsWith("/api/admin/")) return "admin";
  if (
    path.startsWith("/api/imports") ||
    path.startsWith("/api/data/") ||
    path.startsWith("/api/county-details") ||
    (method === "POST" && /^\/api\/properties\/[^/]+\/county$/.test(path))
  )
    return "super-admin";
  if (path === "/api/map" || path === "/api/properties") return "map";
  if (path.startsWith("/api/properties/")) return "property";
  if (path === "/api/follow-ups" || path.startsWith("/api/follow-ups/"))
    // Listing is the follow-up page; scheduling and updating happen from the
    // property panel too.
    return method === "GET" && path === "/api/follow-ups"
      ? "follow-ups"
      : "property";
  if (path === "/api/leads" || path.startsWith("/api/leads/")) return "leads";
  return "signed-in";
}
export function allowed(account: Account, area: Area) {
  if (area === "super-admin") return account.superAdmin;
  if (account.role === "admin" || area === "signed-in") return true;
  if (area === "admin") return false;
  if (area === "property")
    return PROPERTY_MODULES.some((m) => account.modules.includes(m));
  return account.modules.includes(area);
}
// Sign-in off: the app is a single-user tool on this computer, run by its owner.
export const LOCAL_ACCOUNT: Account = {
  email: null,
  role: "admin",
  modules: [...MODULES],
  superAdmin: true,
};
export function accountFrom(row: {
  email: string;
  role: string;
  modules: string[];
  superAdmin?: boolean;
}): Account {
  // The super admin is always an admin as well.
  const superAdmin = row.superAdmin === true,
    admin = superAdmin || row.role === "admin";
  return {
    email: row.email,
    role: admin ? "admin" : "rep",
    // Admins always have every module; a rep has what is listed, in a fixed order.
    modules: MODULES.filter((m) => admin || row.modules.includes(m)),
    superAdmin,
  };
}
