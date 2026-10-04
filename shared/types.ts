import type { Feature, Geometry } from "geojson";
export const STATUSES = [
  "Not visited",
  "No answer",
  "Interested",
  "Not interested",
  "Do not contact",
] as const;
export type ProspectStatus = (typeof STATUSES)[number];
export const PRIORITIES = ["High", "Medium", "Low", "Unknown"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const SOURCE_URL =
  "https://maps.webercountyutah.gov/arcgis/rest/services/gis/parcels_geogizmo2/MapServer/0";
export const PARCEL_SEARCH_URL = "https://webercountyutah.gov/parcelsearch";
export const SOURCE_WHERE = "PROP_DESC = 'SINGLE FAM RES'";
export const UTAH_ZONE = "America/Denver";
export const AGE_THRESHOLDS = { high: 40, medium: 20, earliestYear: 1600 };
export function utahToday(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: UTAH_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function priorityFor(
  year: number | null,
  conflict = false,
  currentYear = Number(utahToday().slice(0, 4)),
): { priority: Priority; age: number | null } {
  if (
    conflict ||
    year === null ||
    !Number.isFinite(year) ||
    year < AGE_THRESHOLDS.earliestYear ||
    year > currentYear
  )
    return { priority: "Unknown", age: null };
  const age = Math.floor(currentYear - year);
  return {
    age,
    priority:
      age >= AGE_THRESHOLDS.high
        ? "High"
        : age >= AGE_THRESHOLDS.medium
          ? "Medium"
          : "Low",
  };
}
export interface Property {
  id: string;
  address: string;
  city: string;
  zip: string;
  category: string;
  year: number | null;
  sqft: number | null;
  lng: number | null;
  lat: number | null;
  active: boolean;
  conflict: boolean;
  issues: string[];
  sourceAt: string;
  // Owner and assessment fields from the county parcel layer (refreshed with each import).
  owner: string | null;
  mailAddress: string | null;
  mailCity: string | null;
  mailZip: string | null;
  taxYear: number | null;
  taxArea: number | null;
  marketValue: number | null;
  taxableValue: number | null;
  taxRate: number | null;
  netAssessment: number | null;
  directCharges: number | null;
  penalty: number | null;
  payments: number | null;
  totalCharge: number | null;
  acres: number | null;
  neighborhood: string | null;
  subdivision: string | null;
  quality: number | null;
  condition: number | null;
  accountType: string | null;
  status: ProspectStatus;
  priority: Priority;
  age: number | null;
  nextFollowUp: string | null;
}
export interface Visit {
  id: string;
  propertyId: string;
  occurredAt: string;
  result: ProspectStatus;
  notes: string;
}
export interface FollowUp {
  id: string;
  propertyId: string;
  dueDate: string;
  state: "pending" | "completed" | "cancelled";
  notes: string;
  createdAt: string;
  updatedAt: string;
  address: string;
  city: string;
}
export interface PropertyDetail extends Property {
  geometries: Feature<Geometry>[];
  visits: Visit[];
  followUps: FollowUp[];
  photos: PropertyPhoto[];
  sourceUrl: string;
  parcelSearchUrl: string;
  county: {
    state: "ok" | "error";
    fetchedAt: string;
    error: string | null;
    data: CountyDetails | null;
  } | null;
}
// A photo taken by a rep. The image itself is stored in Cloudinary.
export interface PropertyPhoto {
  id: string;
  propertyId: string;
  publicId: string;
  url: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}
// What the browser needs to send one photo straight to Cloudinary.
export interface UploadTicket {
  uploadUrl: string;
  fields: Record<string, string>;
}
export interface CountyBuilding {
  number: number;
  type: string | null;
  style: string | null;
  exterior: string | null;
  roof: string | null;
  quality: string | null;
  year: number | null;
  livingSqft: number | null;
  percentComplete: number | null;
  basementSqft: number | null;
  basementFinishPct: number | null;
}
// Scraped from Weber County Parcel Search (current-taxes + property-characteristics).
export interface CountyDetails {
  taxes: {
    taxYear: number | null;
    ownerAsOf: string | null;
    owner: string | null;
    loanCompany: string | null;
    taxArea: number | null;
    marketValue: number | null;
    taxableValue: number | null;
    taxRate: number | null;
    netAssessment: number | null;
    directTotal: number | null;
    penalty: number | null;
    subtotal: number | null;
    paymentsTotal: number | null;
    balance: number | null;
    directCharges: {
      type: string;
      description: string;
      amount: number | null;
      status: string;
    }[];
    payments: {
      date: string;
      payee: string;
      amount: number | null;
      status: string;
    }[];
  };
  characteristics: {
    assessmentYear: number | null;
    acres: number | null;
    greenbelt: boolean | null;
    landType: string | null;
    neighborhood: string | null;
    buildings: CountyBuilding[];
    sketches: string[];
    platMaps: string[];
  };
}
export interface DetailsRun {
  id: string;
  state: "running" | "stopping" | "stopped" | "completed" | "failed";
  mode: "missing" | "refresh";
  startedAt: string;
  finishedAt: string | null;
  total: number;
  processed: number;
  failed: number;
  message: string;
}
export interface DetailsCoverage {
  active: number;
  fetched: number;
  errors: number;
  latest: DetailsRun | null;
}
export interface Filters {
  q?: string;
  city?: string;
  priority?: Priority | "";
  status?: ProspectStatus | "";
  minAge?: string;
  maxAge?: string;
  active?: string;
  bbox?: string;
}
export interface ImportRun {
  id: string;
  state: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  total: number;
  processed: number;
  parcels: number;
  issues: number;
  message: string;
}
export interface Summary {
  total: number;
  high: number;
  visited: number;
  due: number;
  cities: string[];
  mapped: number;
  latest: ImportRun | null;
  today: string;
  photosEnabled: boolean;
}
export interface PropertyPage {
  items: Property[];
  total: number;
  page: number;
  pageSize: number;
}
