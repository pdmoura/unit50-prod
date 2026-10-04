// Works out, for every property with a map position, where Street View should
// stand and which way it should face (see server/streetview.ts), and stores it
// on the property. Run it again after a county import to cover new parcels.
//
//   npx tsx scripts/street-view.ts          production (DATABASE_URL)
//   npx tsx scripts/street-view.ts --dev    local database (DATABASE_URL_DEV)
//
// Roads are downloaded once per run from OpenStreetMap (Overpass API).
import { existsSync } from "node:fs";
import {
  openDb,
  migrate,
  databaseUrl,
  describeDatabase,
} from "../server/db.js";
import { roadIndex, streetView, type Road } from "../server/streetview.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = databaseUrl(),
  sql = openDb(url);
// Roads a Street View car drives and houses are addressed on.
const KINDS =
  "residential|unclassified|tertiary|secondary|primary|trunk|living_street|tertiary_link|secondary_link|primary_link";
try {
  await migrate(sql);
  console.log(`Database: ${describeDatabase(url)}`);
  const properties =
    await sql`SELECT id, address, lat, lng FROM properties WHERE lat IS NOT NULL AND lng IS NOT NULL`;
  if (!properties.length) throw new Error("No properties with a map position.");
  const lats = properties.map((p) => Number(p.lat)),
    lngs = properties.map((p) => Number(p.lng)),
    box = [
      Math.min(...lats) - 0.01,
      Math.min(...lngs) - 0.01,
      Math.max(...lats) + 0.01,
      Math.max(...lngs) + 0.01,
    ].map((n) => n.toFixed(4));
  console.log(`Downloading roads for ${properties.length} properties…`);
  // The public road servers are often busy, so a few of them are tried in turn.
  const servers = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  let response: Response | null = null,
    problem = "";
  for (let attempt = 0; attempt < 6 && !response?.ok; attempt++) {
    const server = servers[attempt % servers.length];
    try {
      response = await fetch(server, {
        method: "POST",
        headers: { "User-Agent": "Unit50/1.0 (street view headings)" },
        body: new URLSearchParams({
          data: `[out:json][timeout:180];way["highway"~"^(${KINDS})$"](${box.join(",")});out geom;`,
        }),
        signal: AbortSignal.timeout(240000),
      });
      if (!response.ok) problem = `HTTP ${response.status} from ${server}`;
    } catch (error) {
      problem = `${(error as Error).message} from ${server}`;
    }
    if (!response?.ok) await new Promise((r) => setTimeout(r, 5000));
  }
  if (!response?.ok) throw new Error(`Road download failed: ${problem}.`);
  const { elements } = (await response.json()) as {
    elements: {
      tags?: Record<string, string>;
      geometry?: { lat: number; lon: number }[];
    }[];
  };
  // A road known by several names is listed once per name, so any of them matches.
  const roads: Road[] = elements.flatMap((way) => {
    const line = (way.geometry || []).map(
      (p) => [p.lon, p.lat] as [number, number],
    );
    const names = [
      ...new Set(
        [
          way.tags?.name,
          way.tags?.alt_name,
          way.tags?.name_1,
          way.tags?.old_name,
        ]
          .flatMap((n) => (n ? n.split(";") : []))
          .map((n) => n.trim()),
      ),
    ];
    return (names.length ? names : [""]).map((name) => ({ name, line }));
  });
  if (roads.length < 100)
    throw new Error("The road download looks incomplete.");
  const index = roadIndex(roads);
  let named = 0,
    nearest = 0,
    none = 0;
  const rows = properties.map((p) => {
    const view = streetView(index, {
      lat: Number(p.lat),
      lng: Number(p.lng),
      address: String(p.address),
    });
    if (!view) none++;
    else if (view.named) named++;
    else nearest++;
    return {
      id: String(p.id),
      streetLat: view?.lat ?? null,
      streetLng: view?.lng ?? null,
      streetHeading: view ? Math.round(view.heading) : null,
    };
  });
  for (let offset = 0; offset < rows.length; offset += 2000) {
    const batch = rows.slice(offset, offset + 2000);
    await sql`UPDATE properties p SET street_lat=v.street_lat::double precision, street_lng=v.street_lng::double precision, street_heading=v.street_heading::double precision FROM (VALUES ${sql(batch.map((r) => [r.id, r.streetLat, r.streetLng, r.streetHeading]))}) AS v (id, street_lat, street_lng, street_heading) WHERE p.id=v.id`;
  }
  console.log(
    `Done. On the address street: ${named}. Nearest road (name not matched): ${nearest}. No road within reach: ${none}.`,
  );
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
