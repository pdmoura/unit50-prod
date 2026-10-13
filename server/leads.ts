// Leads from the website (unit50-studio). The website sends each new lead and
// each follow-up request as a signed webhook POST; this file checks the
// signature, stores the lead, matches it to a county parcel, and serves the
// lead board.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  LEAD_STAGES,
  type Account,
  type Lead,
  type LeadStage,
} from "../shared/types.js";
import { AppError, type Db } from "./db.js";
import { streetKey } from "./streetview.js";
import { metersBetween } from "./streetviewcheck.js";

// A delivery older or newer than this is refused, so a captured request cannot
// be replayed later. The website signs every attempt afresh.
const MAX_CLOCK_SKEW_SECONDS = 300;
// The address point and the parcel's center rarely coincide; a parcel this
// close counts as the same home when the house number does not settle it.
const NEAREST_PARCEL_METERS = 25;

// Headers: X-Unit50-Timestamp (unix seconds) and X-Unit50-Signature, the hex
// HMAC-SHA256 of "<timestamp>.<raw body>" with the shared secret.
export function verifyWebhook(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  now = Date.now(),
) {
  const ts = Number(timestamp);
  if (!timestamp || !Number.isInteger(ts) || !signature) return false;
  if (Math.abs(now / 1000 - ts) > MAX_CLOCK_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface IncomingLead {
  id: string;
  name: string | null;
  phone: string;
  address: string;
  lat: number | null;
  lng: number | null;
  contactPermission: boolean | null;
  followUpRequestedAt: string | null;
  change: string | null;
  collection: string | null;
  photoUrl: string | null;
  designUrl: string | null;
  occurredAt: string;
}
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const coordinate = (value: unknown, limit: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= limit
    ? value
    : null;
// Pictures are shown in the app, so only links to the website's image store
// are kept; anything else is dropped.
function imageUrl(value: unknown) {
  const raw = text(value, 1000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
// Turns a webhook body into a lead, or says why it is not one. Careers
// applications and unknown events are acknowledged and ignored.
export function parseLeadEvent(
  body: unknown,
): { lead: IncomingLead } | { ignored: string } {
  const b = (body ?? {}) as Record<string, unknown>,
    data = (b.data ?? {}) as Record<string, unknown>;
  const event = String(b.event ?? "");
  if (
    ![
      "lead.created",
      "lead.updated",
      "lead.followup_requested",
      "lead.design_ready",
    ].includes(event)
  )
    return { ignored: `event ${event || "(none)"} is not a lead` };
  const id = text(b.leadId, 100);
  if (!id || !/^[\w-]+$/.test(id)) throw new AppError(400, "Missing lead ID.");
  const occurred = Date.parse(String(b.occurredAt ?? ""));
  if (Number.isNaN(occurred)) throw new AppError(400, "Missing event time.");
  const phone = text(data.phone, 20);
  if (!phone || !/^\+[1-9]\d{6,14}$/.test(phone))
    throw new AppError(400, "The lead has no valid phone number.");
  const change = text(data.change, 20);
  return {
    lead: {
      id,
      name: text(data.name, 200),
      phone,
      // Google's version of the address when the website resolved it; what
      // the homeowner typed otherwise.
      address:
        text(data.addressFormatted, 300) ?? text(data.address, 300) ?? "",
      lat: coordinate(data.lat, 90),
      lng: coordinate(data.lng, 180),
      contactPermission:
        typeof data.contactPermission === "boolean"
          ? data.contactPermission
          : null,
      followUpRequestedAt:
        event === "lead.followup_requested"
          ? new Date(occurred).toISOString()
          : null,
      change:
        change && ["siding", "windows", "both"].includes(change)
          ? change
          : null,
      collection: text(data.collectionId, 80),
      photoUrl: imageUrl(data.photoUrl),
      designUrl: imageUrl(data.designUrl),
      occurredAt: new Date(occurred).toISOString(),
    },
  };
}

// The county parcel a lead's address belongs to, when that is clear: the
// parcel near the address point with the same house number and street, or
// failing that the one parcel right at the point. Never a guess.
export async function matchProperty(
  sql: Db,
  lead: { address: string; lat: number | null; lng: number | null },
): Promise<string | null> {
  const street = lead.address.split(",")[0].trim(),
    number = /^\d+/.exec(street)?.[0],
    key = streetKey(street);
  const sameHome = (address: string) =>
    Boolean(number) &&
    address.trim().split(/\s+/)[0] === number &&
    streetKey(address) === key;
  if (lead.lat != null && lead.lng != null) {
    const rows =
      await sql`SELECT id, address, lat, lng FROM properties WHERE active AND lat BETWEEN ${lead.lat - 0.0009} AND ${lead.lat + 0.0009} AND lng BETWEEN ${lead.lng - 0.0012} AND ${lead.lng + 0.0012}`;
    const here = { lat: lead.lat, lng: lead.lng };
    const near = rows
      .map((r) => ({
        id: String(r.id),
        address: String(r.address),
        meters: metersBetween(here, { lat: Number(r.lat), lng: Number(r.lng) }),
      }))
      .sort((a, b) => a.meters - b.meters);
    const named = near.find((r) => sameHome(r.address));
    if (named) return named.id;
    return near[0] && near[0].meters <= NEAREST_PARCEL_METERS
      ? near[0].id
      : null;
  }
  // No map position: an exact house number, street and ZIP, and only one such parcel.
  const zip = /\b(8\d{4})\b/.exec(lead.address)?.[1];
  if (!number || !zip) return null;
  const rows =
    await sql`SELECT id, address FROM properties WHERE active AND zip=${zip} AND address LIKE ${number + " %"}`;
  const matches = rows.filter((r) => sameHome(String(r.address)));
  return matches.length === 1 ? String(matches[0].id) : null;
}

// Stores a lead or adds to it. Deliveries can repeat or arrive out of order
// (the website retries), so fields only fill in, and the phone number and
// contact permission are only replaced by a newer event.
export async function saveLead(sql: Db, lead: IncomingLead) {
  const propertyId = await matchProperty(sql, lead),
    now = new Date().toISOString();
  await sql`INSERT INTO leads (id, name, phone, address, lat, lng, property_id, contact_permission, follow_up_requested_at, change, collection, photo_url, design_url, created_at, last_event_at, received_at, updated_at)
    VALUES (${lead.id}, ${lead.name}, ${lead.phone}, ${lead.address}, ${lead.lat}, ${lead.lng}, ${propertyId}, ${lead.contactPermission}, ${lead.followUpRequestedAt}, ${lead.change}, ${lead.collection}, ${lead.photoUrl}, ${lead.designUrl}, ${lead.occurredAt}, ${lead.occurredAt}, ${now}, ${now})
    ON CONFLICT (id) DO UPDATE SET
      name = COALESCE(excluded.name, leads.name),
      phone = CASE WHEN excluded.last_event_at >= leads.last_event_at THEN excluded.phone ELSE leads.phone END,
      address = CASE WHEN excluded.address <> '' THEN excluded.address ELSE leads.address END,
      lat = COALESCE(excluded.lat, leads.lat),
      lng = COALESCE(excluded.lng, leads.lng),
      property_id = COALESCE(excluded.property_id, leads.property_id),
      contact_permission = CASE WHEN excluded.last_event_at >= leads.last_event_at
        THEN COALESCE(excluded.contact_permission, leads.contact_permission)
        ELSE COALESCE(leads.contact_permission, excluded.contact_permission) END,
      follow_up_requested_at = COALESCE(leads.follow_up_requested_at, excluded.follow_up_requested_at),
      change = COALESCE(excluded.change, leads.change),
      collection = COALESCE(excluded.collection, leads.collection),
      photo_url = COALESCE(excluded.photo_url, leads.photo_url),
      design_url = COALESCE(excluded.design_url, leads.design_url),
      created_at = LEAST(leads.created_at, excluded.created_at),
      last_event_at = GREATEST(leads.last_event_at, excluded.last_event_at),
      updated_at = excluded.updated_at`;
}

const LEAD_COLUMNS = (sql: Db) =>
  sql`id, name, phone, address, lat, lng, property_id, contact_permission, follow_up_requested_at, change, collection, photo_url, design_url, stage, owner, notes, created_at, updated_at`;
// A rep sees the shared pool and their own leads; an admin sees every lead.
export async function listLeads(sql: Db, account: Account): Promise<Lead[]> {
  const visible =
    account.role === "admin"
      ? sql`TRUE`
      : sql`(owner IS NULL OR owner = ${account.email})`;
  return (await sql`SELECT ${LEAD_COLUMNS(sql)} FROM leads WHERE ${visible} ORDER BY COALESCE(follow_up_requested_at, created_at) DESC LIMIT 1000`) as unknown as Lead[];
}
// Moves a lead along the pipeline, changes its notes, or changes who works it.
// A rep can take a lead from the pool (any change to a pool lead takes it),
// work their own, or hand their own back; only an admin can give a lead to
// someone else or take one from another rep.
export async function updateLead(
  sql: Db,
  account: Account,
  id: string,
  change: { stage?: LeadStage; notes?: string; owner?: string | null },
): Promise<Lead> {
  if (change.stage && !LEAD_STAGES.includes(change.stage))
    throw new AppError(400, "Unknown pipeline stage.");
  return sql.begin(async (tx) => {
    const t = tx as unknown as Db;
    const [lead] =
      (await t`SELECT ${LEAD_COLUMNS(t)} FROM leads WHERE id=${id} FOR UPDATE`) as unknown as Lead[];
    const admin = account.role === "admin",
      me = account.email;
    if (!lead || (!admin && lead.owner && lead.owner !== me))
      throw new AppError(
        lead ? 409 : 404,
        lead ? "Another rep is already working this lead." : "Lead not found.",
      );
    let owner = lead.owner;
    if (change.owner !== undefined) {
      const target = change.owner?.toLowerCase() ?? null;
      if (!admin && target !== null && target !== me)
        throw new AppError(
          403,
          "Only an admin can give a lead to someone else.",
        );
      if (target) {
        const [person] = await t`SELECT 1 FROM app_users WHERE email=${target}`;
        if (!person) throw new AppError(400, "That person is not on the team.");
      }
      owner = target;
    } else if (!admin && !lead.owner) owner = me;
    const [saved] =
      (await t`UPDATE leads SET stage=${change.stage ?? lead.stage}, notes=${(change.notes ?? lead.notes).trim()}, owner=${owner}, updated_at=${new Date().toISOString()} WHERE id=${id} RETURNING ${LEAD_COLUMNS(t)}`) as unknown as Lead[];
    return saved;
  }) as Promise<Lead>;
}
