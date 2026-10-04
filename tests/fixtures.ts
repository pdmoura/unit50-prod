import type { SourceFeature, Source } from "../server/importer.js";
export function feature(
  id = 1,
  parcel = "001234567",
  overrides: Record<string, unknown> = {},
): SourceFeature {
  return {
    type: "Feature",
    id,
    properties: {
      OBJECTID: id,
      PARCEL_ID: parcel,
      PROP_STREET: "120 TEST ST",
      PROP_CITY: "OGDEN",
      PROP_ZIP: "84401",
      PROP_DESC: "SINGLE FAM RES",
      WGT_AVE_RI_YB: 1970,
      TTL_RI_SQFT: 1800,
      ...overrides,
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-111.98, 41.23],
          [-111.979, 41.23],
          [-111.979, 41.231],
          [-111.98, 41.231],
          [-111.98, 41.23],
        ],
      ],
    },
  };
}
export function source(features: SourceFeature[]): Source {
  return {
    ids: async () => features.map((f) => Number(f.properties.OBJECTID)),
    batch: async (ids) =>
      features.filter((f) => ids.includes(Number(f.properties.OBJECTID))),
  };
}
