import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  AGE_THRESHOLDS,
  SOURCE_URL,
  PARCEL_SEARCH_URL,
  priorityFor,
  utahToday,
  type Filters,
  type Property,
  type PropertyDetail,
  type PropertyPhoto,
  type FollowUp,
  type Visit,
  type ImportRun,
  type ProspectStatus,
} from "../shared/types.js";
import { MIGRATIONS } from "./migrations.js";

export const databaseUrl = () => {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL is not set. Add it to .env (see .env.example).",
    );
  return url;
};
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
// Rows come back with camelCase keys, dates as YYYY-MM-DD strings and
// timestamps as ISO strings, matching the shapes in shared/types.ts.
export function openDb(url = databaseUrl(), schema?: string) {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    connection: schema ? { search_path: schema } : {},
    transform: {
      column: { to: postgres.fromCamel, from: postgres.toCamel },
      undefined: null,
    },
    types: {
      date: {
        to: 1184,
        from: [1114, 1184],
        serialize: (x: string | Date) => new Date(x).toISOString(),
        parse: (x: string) => new Date(x).toISOString(),
      },
      day: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
    },
  });
}
export type Db = ReturnType<typeof openDb>;
export async function migrate(sql: Db) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL)`;
  const applied = new Set(
    (await sql`SELECT version FROM schema_migrations`).map((r) => r.version),
  );
  for (const m of MIGRATIONS)
    if (!applied.has(m.version))
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations VALUES (${m.version}, now())`;
      });
}
export async function bumpRevision(sql: Db) {
  await sql`UPDATE metadata SET value=(value::int + 1)::text WHERE key='revision'`;
}
export async function revision(sql: Db) {
  return String(
    (await sql`SELECT value FROM metadata WHERE key='revision'`)[0]?.value,
  );
}
export async function importRun(
  sql: Db,
  id?: string,
): Promise<ImportRun | null> {
  const rows = id
    ? await sql`SELECT * FROM imports WHERE id=${id}`
    : await sql`SELECT * FROM imports ORDER BY started_at DESC LIMIT 1`;
  return (rows[0] as ImportRun | undefined) || null;
}
const year = () => Number(utahToday().slice(0, 4));
// Built from numeric constants only, so it is safe to embed as raw SQL.
export function prioritySql(sql: Db) {
  return sql.unsafe(
    `CASE WHEN p.conflict OR p.year IS NULL OR p.year<${AGE_THRESHOLDS.earliestYear} OR p.year>${year()} THEN 'Unknown' WHEN p.year<=${year() - 40} THEN 'High' WHEN p.year<=${year() - 20} THEN 'Medium' ELSE 'Low' END`,
  );
}
export function whereFor(sql: Db, f: Filters = {}) {
  const terms = [];
  if (f.active !== "all") terms.push(sql`p.active`);
  if (f.q) {
    const q = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    terms.push(
      sql`(p.address ILIKE ${q} OR p.id ILIKE ${q} OR p.owner ILIKE ${q})`,
    );
  }
  if (f.city) terms.push(sql`p.city=${f.city}`);
  if (f.status) terms.push(sql`COALESCE(s.status,'Not visited')=${f.status}`);
  if (f.priority) terms.push(sql`(${prioritySql(sql)})=${f.priority}`);
  // Age is the whole number of years, as in priorityFor().
  const age = sql.unsafe(`floor(${year()}-p.year)`);
  if (f.minAge !== undefined && f.minAge !== "")
    terms.push(
      sql`(${prioritySql(sql)})!='Unknown' AND ${age}>=${Number(f.minAge)}`,
    );
  if (f.maxAge !== undefined && f.maxAge !== "")
    terms.push(
      sql`(${prioritySql(sql)})!='Unknown' AND ${age}<=${Number(f.maxAge)}`,
    );
  if (f.bbox) {
    const [w, s, e, n] = f.bbox.split(",").map(Number);
    terms.push(
      sql`p.lng BETWEEN ${w} AND ${e} AND p.lat BETWEEN ${s} AND ${n}`,
    );
  }
  return terms.length
    ? terms.reduce((all, term) => sql`${all} AND ${term}`)
    : sql`TRUE`;
}
const baseSelect = (sql: Db) =>
  sql`SELECT p.*, COALESCE(s.status,'Not visited') AS status, (SELECT MIN(due_date) FROM follow_ups f WHERE f.property_id=p.id AND f.state='pending') AS next_follow_up FROM properties p LEFT JOIN prospects s ON s.property_id=p.id`;
export function toProperty(raw: Record<string, unknown>): Property {
  return {
    ...raw,
    ...priorityFor(raw.year as number | null, Boolean(raw.conflict)),
  } as Property;
}
export async function listProperties(
  sql: Db,
  filters: Filters,
  page = 1,
  pageSize = 40,
) {
  const where = whereFor(sql, filters);
  const [count, rows] = await Promise.all([
    sql`SELECT COUNT(*)::int AS n FROM properties p LEFT JOIN prospects s ON s.property_id=p.id WHERE ${where}`,
    sql`${baseSelect(sql)} WHERE ${where} ORDER BY (${prioritySql(sql)})='Unknown', p.year ASC, p.id ASC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
  ]);
  return {
    items: rows.map(toProperty),
    total: Number(count[0].n),
    page,
    pageSize,
  };
}
export async function detail(sql: Db, id: string): Promise<PropertyDetail> {
  const [raw] = await sql`${baseSelect(sql)} WHERE p.id=${id}`;
  if (!raw) throw new AppError(404, "Property not found.");
  const [geometries, visits, tasks, county, pictures] = await Promise.all([
    sql`SELECT geojson FROM geometries WHERE property_id=${id} AND geojson IS NOT NULL ORDER BY source_id`,
    sql`SELECT * FROM visits WHERE property_id=${id} ORDER BY occurred_at DESC`,
    followUps(sql, id),
    countyDetails(sql, id),
    photos(sql, id),
  ]);
  return {
    ...toProperty(raw),
    geometries: geometries.map((r) => ({
      type: "Feature" as const,
      properties: {},
      geometry: r.geojson,
    })),
    visits: visits as unknown as Visit[],
    followUps: tasks,
    photos: pictures,
    sourceUrl: SOURCE_URL,
    parcelSearchUrl: `${PARCEL_SEARCH_URL}/current-taxes.php?id=${encodeURIComponent(id)}`,
    county,
  };
}
export async function countyDetails(sql: Db, id: string) {
  const [row] =
    await sql`SELECT state, fetched_at, error, data FROM county_details WHERE property_id=${id}`;
  if (!row) return null;
  return {
    state: row.state as "ok" | "error",
    fetchedAt: String(row.fetchedAt),
    error: (row.error as string | null) ?? null,
    data: row.data ?? null,
  };
}
export async function photos(sql: Db, propertyId: string) {
  return (await sql`SELECT id, property_id, public_id, url, width, height, created_at FROM property_photos WHERE property_id=${propertyId} ORDER BY created_at DESC`) as unknown as PropertyPhoto[];
}
export async function requireProperty(
  sql: Db,
  id: string,
  contactable = false,
) {
  const [row] =
    await sql`SELECT p.active, COALESCE(s.status,'Not visited') AS status FROM properties p LEFT JOIN prospects s ON s.property_id=p.id WHERE p.id=${id}`;
  if (!row) throw new AppError(404, "Property not found.");
  if (contactable && row.status === "Do not contact")
    throw new AppError(409, "This property is marked Do not contact.");
  if (contactable && !row.active)
    throw new AppError(
      409,
      "This property is no longer active in the county dataset.",
    );
  return row;
}
async function setStatus(sql: Db, id: string, status: ProspectStatus) {
  const now = new Date().toISOString();
  await sql`INSERT INTO prospects VALUES (${id}, ${status}, ${now}) ON CONFLICT (property_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`;
  if (status === "Do not contact")
    await sql`UPDATE follow_ups SET state='cancelled', updated_at=${now} WHERE property_id=${id} AND state='pending'`;
  await bumpRevision(sql);
}
export async function updateProspect(
  sql: Db,
  id: string,
  status: ProspectStatus,
) {
  await sql.begin(async (tx) => {
    await requireProperty(tx as unknown as Db, id);
    await setStatus(tx as unknown as Db, id, status);
  });
}
export async function addVisit(
  sql: Db,
  propertyId: string,
  result: ProspectStatus,
  notes: string,
  occurredAt = new Date().toISOString(),
) {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await requireProperty(tx as unknown as Db, propertyId, true);
    await tx`INSERT INTO visits VALUES (${id}, ${propertyId}, ${occurredAt}, ${result}, ${notes.trim()})`;
    await setStatus(tx as unknown as Db, propertyId, result);
  });
  return id;
}
export function validDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number(date.slice(0, 4)) >= 1900 &&
    Number(date.slice(0, 4)) <= 2200 &&
    !Number.isNaN(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
export async function followUps(
  sql: Db,
  propertyId?: string,
): Promise<FollowUp[]> {
  return (await sql`SELECT f.*, p.address, p.city FROM follow_ups f JOIN properties p ON p.id=f.property_id ${propertyId ? sql`WHERE f.property_id=${propertyId}` : sql``} ORDER BY f.due_date, f.created_at`) as unknown as FollowUp[];
}
export async function addFollowUp(
  sql: Db,
  propertyId: string,
  dueDate: string,
  notes: string,
) {
  if (!validDate(dueDate))
    throw new AppError(400, "Enter a valid calendar date.");
  const id = randomUUID(),
    now = new Date().toISOString();
  await sql.begin(async (tx) => {
    await requireProperty(tx as unknown as Db, propertyId, true);
    await tx`INSERT INTO follow_ups VALUES (${id}, ${propertyId}, ${dueDate}, 'pending', ${notes.trim()}, ${now}, ${now})`;
  });
  return id;
}
export async function updateFollowUp(
  sql: Db,
  id: string,
  update: {
    dueDate?: string;
    state?: "pending" | "completed" | "cancelled";
    notes?: string;
  },
) {
  await sql.begin(async (tx) => {
    const [row] =
      (await tx`SELECT * FROM follow_ups WHERE id=${id} FOR UPDATE`) as unknown as FollowUp[];
    if (!row) throw new AppError(404, "Follow-up not found.");
    const state = update.state || row.state,
      dueDate = update.dueDate || row.dueDate;
    if (!validDate(dueDate))
      throw new AppError(400, "Enter a valid calendar date.");
    if (state === "pending")
      await requireProperty(tx as unknown as Db, row.propertyId, true);
    await tx`UPDATE follow_ups SET due_date=${dueDate}, state=${state}, notes=${(update.notes ?? row.notes).trim()}, updated_at=${new Date().toISOString()} WHERE id=${id}`;
  });
}
