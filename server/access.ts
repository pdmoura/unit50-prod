import { MODULES, type Account, type Module } from "../shared/types.js";

// Which part of Unit 50 an API call belongs to. The server checks this on every
// request, so turning a module off for someone takes effect on their next click.
//
// The property panel opens from the map, the follow-up list and the lead board,
// so property work is allowed with any of those three modules.
export type Area = Module | "property" | "admin" | "signed-in";
const PROPERTY_MODULES: Module[] = ["map", "follow-ups", "leads"];

export function areaFor(method: string, path: string): Area {
  if (path.startsWith("/api/admin/")) return "admin";
  if (path === "/api/map" || path === "/api/properties") return "map";
  if (path.startsWith("/api/properties/")) return "property";
  if (path === "/api/follow-ups" || path.startsWith("/api/follow-ups/"))
    // Listing is the follow-up page; scheduling and updating happen from the
    // property panel too.
    return method === "GET" && path === "/api/follow-ups"
      ? "follow-ups"
      : "property";
  if (path === "/api/leads" || path.startsWith("/api/leads/")) return "leads";
  if (
    path.startsWith("/api/imports") ||
    path.startsWith("/api/data/") ||
    path.startsWith("/api/county-details")
  )
    return "data";
  return "signed-in";
}
export function allowed(account: Account, area: Area) {
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
};
export function accountFrom(row: {
  email: string;
  role: string;
  modules: string[];
}): Account {
  const admin = row.role === "admin";
  return {
    email: row.email,
    role: admin ? "admin" : "rep",
    // Admins always have every module; a rep has what is listed, in a fixed order.
    modules: MODULES.filter((m) => admin || row.modules.includes(m)),
  };
}
