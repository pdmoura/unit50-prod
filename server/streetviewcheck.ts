// Asks Google whether Street View imagery exists in front of a property.
//
// This uses the Street View Static API *metadata* request, which is free and
// answers with a status and a panorama ID. No image is downloaded: Google's
// terms do not allow storing or rehosting Street View pictures, but they do
// allow keeping the panorama ID, which is all the app needs to open or show
// the right picture later.
import { createHmac } from "node:crypto";

export const METADATA_URL =
  "https://maps.googleapis.com/maps/api/streetview/metadata";
const METERS_PER_DEGREE = 111320;
// A panorama this close to the expected spot on the road is the one in front
// of the property. Google's cars drive within a few meters of the road line.
export const FRONT_METERS = 25;
// How far around the parcel to look before saying there is no imagery at all.
export const NEARBY_METERS = 150;

export interface CheckTarget {
  id: string;
  lat: number;
  lng: number;
  streetLat: number | null;
  streetLng: number | null;
}
export type CheckResult =
  // Imagery in front of the property; pano identifies the exact picture.
  | { outcome: "available"; pano: string; detail: string }
  // Google confirmed there is nothing near the road point or the parcel.
  | { outcome: "none"; detail: string }
  // Imagery exists nearby but not where the front of the property should be.
  | { outcome: "uncertain"; detail: string }
  // The check itself did not work; says nothing about coverage.
  | { outcome: "failed"; detail: string };
export interface CheckOptions {
  key: string;
  // URL signing secret from the Google Cloud console (optional).
  secret?: string;
  fetcher?: typeof fetch;
  baseUrl?: string;
  retries?: number;
  timeoutMs?: number;
  // Wait before retry number n (1-based); tests pass 0.
  backoffMs?: (attempt: number) => number;
}
// The key was refused or the API is not enabled: every request would fail the
// same way, so the whole run stops instead of marking properties as failed.
export class StreetViewDenied extends Error {}

// Google's URL signature: HMAC-SHA1 of the path and query, with the secret and
// the result in URL-safe base64.
export function signUrl(pathAndQuery: string, secret: string) {
  const key = Buffer.from(
    secret.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
  const signature = createHmac("sha1", key)
    .update(pathAndQuery)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  return `${pathAndQuery}&signature=${signature}`;
}
export function metersBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const east =
      (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180) * METERS_PER_DEGREE,
    north = (b.lat - a.lat) * METERS_PER_DEGREE;
  return Math.hypot(east, north);
}
interface Metadata {
  status: string;
  pano_id?: string;
  location?: { lat: number; lng: number };
  error_message?: string;
}
// One metadata request, retried on timeouts, server errors and rate limits.
// Error text never includes the request URL, which carries the API key.
async function metadata(
  point: { lat: number; lng: number },
  radius: number,
  o: CheckOptions,
): Promise<Metadata> {
  const fetcher = o.fetcher ?? fetch,
    base = new URL(o.baseUrl ?? METADATA_URL),
    retries = o.retries ?? 3,
    backoff = o.backoffMs ?? ((n) => 1000 * 2 ** (n - 1));
  // Outdoor only: a shop interior near the road is not a view of the house.
  const query = new URLSearchParams({
    location: `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`,
    radius: String(radius),
    source: "outdoor",
    key: o.key,
  });
  const pathAndQuery = `${base.pathname}?${query}`,
    url =
      base.origin + (o.secret ? signUrl(pathAndQuery, o.secret) : pathAndQuery);
  let problem = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, backoff(attempt)));
    try {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(o.timeoutMs ?? 15000),
      });
      if (response.status === 403)
        throw new StreetViewDenied(
          "Google refused the API key (HTTP 403). Check the key, its restrictions and that the Street View Static API is enabled.",
        );
      if (!response.ok) {
        problem = `HTTP ${response.status}`;
        continue;
      }
      const body = (await response.json()) as Metadata;
      if (body.status === "REQUEST_DENIED")
        throw new StreetViewDenied(
          `Google denied the request: ${body.error_message || "no reason given"}`,
        );
      if (
        body.status === "OVER_QUERY_LIMIT" ||
        body.status === "UNKNOWN_ERROR"
      ) {
        problem = body.status;
        continue;
      }
      return body;
    } catch (error) {
      if (error instanceof StreetViewDenied) throw error;
      problem =
        (error as Error).name === "TimeoutError"
          ? "timed out"
          : `request failed (${(error as Error).name})`;
    }
  }
  throw new Error(`${problem} after ${retries + 1} attempts`);
}
export async function checkProperty(
  p: CheckTarget,
  o: CheckOptions,
): Promise<CheckResult> {
  const parcel = { lat: p.lat, lng: p.lng },
    front =
      p.streetLat != null && p.streetLng != null
        ? { lat: p.streetLat, lng: p.streetLng }
        : null;
  try {
    if (front) {
      const near = await metadata(front, 50, o);
      if (near.status === "OK" && near.pano_id && near.location) {
        const meters = Math.round(metersBetween(front, near.location));
        return meters <= FRONT_METERS
          ? {
              outcome: "available",
              pano: near.pano_id,
              detail: `picture ${meters} m from the expected spot`,
            }
          : {
              outcome: "uncertain",
              detail: `nearest picture is ${meters} m from the expected spot on the road`,
            };
      }
      if (near.status !== "ZERO_RESULTS")
        return {
          outcome: "failed",
          detail: `unexpected answer: ${near.status}`,
        };
    }
    // Nothing in front (or no road point to look from). "No Street View" is
    // only recorded when a wider look around the parcel finds nothing either.
    const wide = await metadata(parcel, NEARBY_METERS, o);
    if (wide.status === "ZERO_RESULTS")
      return {
        outcome: "none",
        detail: `no picture within ${NEARBY_METERS} m`,
      };
    if (wide.status === "OK" && wide.location)
      return {
        outcome: "uncertain",
        detail: front
          ? `no picture in front; nearest is ${Math.round(metersBetween(parcel, wide.location))} m from the parcel`
          : `no road point for this property; nearest picture is ${Math.round(metersBetween(parcel, wide.location))} m from the parcel`,
      };
    return { outcome: "failed", detail: `unexpected answer: ${wide.status}` };
  } catch (error) {
    if (error instanceof StreetViewDenied) throw error;
    return { outcome: "failed", detail: (error as Error).message };
  }
}
