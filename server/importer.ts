import postgres from "postgres";
import type { Geometry, Feature } from "geojson";
import { pointOnFeature } from "@turf/point-on-feature";
import { SOURCE_URL, SOURCE_WHERE, priorityFor } from "../shared/types.js";
import { bumpRevision, type Db } from "./db.js";

// Owner and assessment columns filled from the county parcel layer on import.
export const COUNTY_COLUMNS = [
  "owner",
  "mailAddress",
  "mailCity",
  "mailZip",
  "taxYear",
  "taxArea",
  "marketValue",
  "taxableValue",
  "taxRate",
  "netAssessment",
  "directCharges",
  "penalty",
  "payments",
  "totalCharge",
  "acres",
  "neighborhood",
  "subdivision",
  "quality",
  "condition",
  "accountType",
] as const;

export interface SourceFeature {
  type: "Feature";
  id?: number;
  properties: Record<string, unknown>;
  geometry: Geometry | null;
}
export interface Source {
  ids(): Promise<number[]>;
  batch(ids: number[]): Promise<SourceFeature[]>;
}
const fields =
  "OBJECTID,PARCEL_ID,PROP_STREET,PROP_CITY,PROP_ZIP,PROP_DESC,WGT_AVE_RI_YB,TTL_RI_SQFT," +
  "NAME_ONE,STREET,CITY_STATE,ZIPCODE,TaxYear,TAX_UNIT,TOT_MARKET,TOT_TAXABLE,YR_RATE,NET_ASMT_CHAR," +
  "TOT_DIRECT,PENALTY_CHAR,TOT_PAYMENTS,TotalCharge,landgrossacrecount,LEA,SUBDIVISIO,WGT_AVE_RI_QLTY," +
  "WGT_AVE_RI_CDTN,ACCOUNT_TYPE";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function query(params: Record<string, string>) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(
        `${SOURCE_URL}/query?${new URLSearchParams(params)}`,
        {
          signal: AbortSignal.timeout(45000),
          headers: { "User-Agent": "Unit50-Local-MVP/1.0" },
        },
      );
      if (!response.ok)
        throw new Error(`County service returned HTTP ${response.status}`);
      const body = (await response.json()) as any;
      if (body.error)
        throw new Error(body.error.message || "County query failed");
      return body;
    } catch (e) {
      last = e;
      if (attempt < 2) await pause(1000 * 2 ** attempt);
    }
  }
  throw last;
}
export const countySource: Source = {
  async ids() {
    const d = await query({
      f: "json",
      where: SOURCE_WHERE,
      returnIdsOnly: "true",
    });
    if (!Array.isArray(d.objectIds) || !d.objectIds.length)
      throw new Error("County returned no IDs. The previous dataset was kept.");
    return d.objectIds;
  },
  async batch(ids) {
    const d = await query({
      f: "geojson",
      objectIds: ids.join(","),
      outFields: fields,
      outSR: "4326",
      returnGeometry: "true",
    });
    if (!Array.isArray(d.features))
      throw new Error("County returned an invalid feature response.");
    return d.features;
  },
};
function text(v: unknown) {
  return v == null ? "" : String(v).trim();
}
function number(v: unknown) {
  return v === null || v === undefined || v === ""
    ? null
    : Number.isFinite(Number(v))
      ? Number(v)
      : null;
}
function rounded(v: number | null, digits: number) {
  return v === null ? null : Number(v.toFixed(digits));
}
export function normalize(feature: SourceFeature) {
  const a = feature.properties,
    parcelId = text(a.PARCEL_ID),
    sourceId = Number(a.OBJECTID ?? feature.id);
  if (!parcelId || !Number.isSafeInteger(sourceId))
    throw new Error("Source record is missing a parcel ID or object ID.");
  const year = number(a.WGT_AVE_RI_YB),
    sqft = number(a.TTL_RI_SQFT);
  const attributes = {
    address: text(a.PROP_STREET),
    city: text(a.PROP_CITY),
    zip: text(a.PROP_ZIP),
    category: text(a.PROP_DESC),
    year,
    sqft,
  };
  // Owner and assessment values. Kept apart from `attributes` so they do not
  // take part in the duplicate-geometry conflict check.
  const county = {
    owner: text(a.NAME_ONE) || null,
    mailAddress: text(a.STREET) || null,
    mailCity: text(a.CITY_STATE) || null,
    mailZip: text(a.ZIPCODE) || null,
    taxYear: number(a.TaxYear),
    taxArea: number(a.TAX_UNIT),
    marketValue: number(a.TOT_MARKET),
    taxableValue: number(a.TOT_TAXABLE),
    // YR_RATE is a single-precision float; the county publishes 6 decimals.
    taxRate: rounded(number(a.YR_RATE), 6),
    netAssessment: number(a.NET_ASMT_CHAR),
    directCharges: number(a.TOT_DIRECT),
    penalty: number(a.PENALTY_CHAR),
    payments: number(a.TOT_PAYMENTS),
    totalCharge: number(a.TotalCharge),
    acres: number(a.landgrossacrecount),
    neighborhood: text(a.LEA) || null,
    subdivision: text(a.SUBDIVISIO) || null,
    quality: number(a.WGT_AVE_RI_QLTY),
    condition: number(a.WGT_AVE_RI_CDTN),
    accountType: text(a.ACCOUNT_TYPE) || null,
  } satisfies Record<(typeof COUNTY_COLUMNS)[number], unknown>;
  const issues: string[] = [];
  if (!attributes.address) issues.push("Missing property address");
  if (priorityFor(year).priority === "Unknown")
    issues.push("Missing or invalid construction year");
  let geometry: Geometry | null = feature.geometry,
    lng: number | null = null,
    lat: number | null = null;
  try {
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type))
      throw new Error("Invalid polygon");
    const coords = (geometry as any).coordinates;
    function check(c: any): void {
      if (!Array.isArray(c) || !c.length) throw new Error("Empty geometry");
      if (typeof c[0] === "number") {
        if (
          !Number.isFinite(c[0]) ||
          !Number.isFinite(c[1]) ||
          c[0] < -180 ||
          c[0] > 180 ||
          c[1] < -90 ||
          c[1] > 90
        )
          throw new Error("Invalid coordinates");
      } else c.forEach(check);
    }
    check(coords);
    const point = pointOnFeature({
      type: "Feature",
      properties: {},
      geometry,
    } as Feature).geometry.coordinates;
    [lng, lat] = point;
    if (lng < -113 || lng > -110 || lat < 40 || lat > 43)
      throw new Error("Outside Weber County region");
  } catch {
    geometry = null;
    lng = null;
    lat = null;
    issues.push("Missing or invalid geometry");
  }
  return { sourceId, parcelId, attributes, county, geometry, lng, lat, issues };
}
export async function activateImport(sql: Db, runId: string, expected: number) {
  const rows =
    await sql`SELECT source_id, parcel_id, attributes, county, lng, lat, issues FROM staging WHERE run_id=${runId} ORDER BY source_id`;
  if (rows.length !== expected || !expected)
    throw new Error(
      `Incomplete import: expected ${expected} records, received ${rows.length}.`,
    );
  const groups = new Map<
    string,
    {
      a: any;
      county: Record<string, unknown>;
      signature: string;
      lng: number | null;
      lat: number | null;
      issues: Set<string>;
      conflict: boolean;
    }
  >();
  for (const row of rows) {
    const id = String(row.parcelId),
      signature = JSON.stringify(row.attributes),
      issues = row.issues as string[];
    const old = groups.get(id);
    if (old) {
      if (old.signature !== signature) {
        old.conflict = true;
        old.issues.add(
          "Conflicting county attributes across parcel geometries",
        );
      }
      issues.forEach((x) => old.issues.add(x));
      if (old.lng === null && row.lng !== null) {
        old.lng = Number(row.lng);
        old.lat = Number(row.lat);
      }
    } else
      groups.set(id, {
        a: row.attributes,
        county: row.county ?? {},
        signature,
        lng: row.lng as number | null,
        lat: row.lat as number | null,
        issues: new Set(issues),
        conflict: false,
      });
  }
  const now = new Date().toISOString();
  let issueCount = 0;
  const columns = [
    "id",
    "address",
    "city",
    "zip",
    "category",
    "year",
    "sqft",
    "lng",
    "lat",
    "active",
    "conflict",
    "issues",
    "sourceAt",
    ...COUNTY_COLUMNS,
  ] as const;
  const records = [...groups].map(([id, g]) => {
    if (g.issues.size) issueCount++;
    return {
      id,
      address: g.a.address,
      city: g.a.city,
      zip: g.a.zip,
      category: g.a.category,
      year: g.a.year,
      sqft: g.a.sqft,
      lng: g.lng,
      lat: g.lat,
      active: true,
      conflict: g.conflict,
      issues: sql.json([...g.issues]),
      sourceAt: now,
      ...Object.fromEntries(
        COUNTY_COLUMNS.map((n) => [n, g.county[n] ?? null]),
      ),
    };
  });
  // Everything except the parcel id is replaced by the county's current values.
  const overwrite = columns
    .filter((c) => c !== "id")
    .map((c) => `${postgres.fromCamel(c)}=excluded.${postgres.fromCamel(c)}`)
    .join(",");
  await sql.begin(async (tx) => {
    await tx`UPDATE properties SET active=false`;
    for (let offset = 0; offset < records.length; offset += 1000)
      await tx`INSERT INTO properties ${tx(records.slice(offset, offset + 1000) as any, ...columns)} ON CONFLICT (id) DO UPDATE SET ${tx.unsafe(overwrite)}`;
    await tx`DELETE FROM geometries`;
    await tx`INSERT INTO geometries (source_id, property_id, geojson) SELECT source_id, parcel_id, geometry FROM staging WHERE run_id=${runId}`;
    await tx`UPDATE imports SET state='completed', finished_at=${now}, processed=${expected}, parcels=${groups.size}, issues=${issueCount}, message='Dataset validated and activated.' WHERE id=${runId}`;
    await tx`DELETE FROM staging WHERE run_id=${runId}`;
    await bumpRevision(tx as unknown as Db);
  });
}
export async function runImport(
  sql: Db,
  runId: string,
  source: Source = countySource,
) {
  try {
    const ids = await source.ids();
    if (
      ids.length === 0 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !Number.isSafeInteger(id))
    )
      throw new Error("Invalid source object ID list.");
    await sql`UPDATE imports SET total=${ids.length}, message='Downloading county parcels…' WHERE id=${runId}`;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const requested = ids.slice(offset, offset + 500),
        features = await source.batch(requested);
      const normalized = features.map(normalize),
        received = new Set(normalized.map((f) => f.sourceId));
      if (
        received.size !== requested.length ||
        features.length !== requested.length ||
        requested.some((id) => !received.has(id))
      )
        throw new Error(
          `Batch at ${offset} did not match the requested IDs. Previous data kept.`,
        );
      const staged = normalized.map((f) => ({
        runId,
        sourceId: f.sourceId,
        parcelId: f.parcelId,
        attributes: sql.json(f.attributes),
        geometry: f.geometry ? sql.json(f.geometry as any) : null,
        lng: f.lng,
        lat: f.lat,
        issues: sql.json(f.issues),
        county: sql.json(f.county),
      }));
      await sql.begin(async (tx) => {
        await tx`INSERT INTO staging ${tx(staged as any, "runId", "sourceId", "parcelId", "attributes", "geometry", "lng", "lat", "issues", "county")}`;
        await tx`UPDATE imports SET processed=${offset + features.length}, message='Downloading and validating parcels…' WHERE id=${runId}`;
      });
    }
    await sql`UPDATE imports SET message='Activating validated dataset…' WHERE id=${runId}`;
    await activateImport(sql, runId, ids.length);
  } catch (error) {
    await sql`UPDATE imports SET state='failed', finished_at=${new Date().toISOString()}, message=${error instanceof Error ? error.message : "Import failed"} WHERE id=${runId}`;
    await sql`DELETE FROM staging WHERE run_id=${runId}`;
  }
}
