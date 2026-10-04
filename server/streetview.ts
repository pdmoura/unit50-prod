// Where to stand and which way to look to see a property from the street.
//
// A Street View link needs a camera heading; without one Google faces north.
// The camera is placed on the road in front of the property (the nearest point
// of the road named in the address, or of any road when the name is unknown)
// and turned toward the parcel. Roads come from OpenStreetMap.
export interface Road {
  name: string;
  line: [number, number][]; // [lng, lat] pairs
}
export interface StreetView {
  lat: number;
  lng: number;
  heading: number; // degrees clockwise from north, 0-360
  distance: number; // meters from the road point to the property point
  named: boolean; // true when the road matches the address street
}
const METERS_PER_DEGREE = 111320;
const WORDS: Record<string, string> = {
  NORTH: "N",
  SOUTH: "S",
  EAST: "E",
  WEST: "W",
  STREET: "ST",
  AVENUE: "AVE",
  DRIVE: "DR",
  ROAD: "RD",
  LANE: "LN",
  COURT: "CT",
  CIRCLE: "CIR",
  BOULEVARD: "BLVD",
  PLACE: "PL",
  PARKWAY: "PKWY",
  HIGHWAY: "HWY",
  TRAIL: "TRL",
  TERRACE: "TER",
  COVE: "CV",
  WY: "WAY",
};
const DIRECTIONS = new Set(["N", "S", "E", "W"]);
// "1652 APACHE WAY" and "Apache Way" both become "APACHE WAY";
// "3147 N 2575 W" and "North 2575 West" both become "2575 W".
export function streetKey(text: string) {
  const tokens = text
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => WORDS[t] || t);
  // A leading house number is followed by the street; a grid street ("2575 W")
  // is itself a number, so only drop the first number when more follows.
  if (
    tokens.length > 2 &&
    /^\d+$/.test(tokens[0]) &&
    !DIRECTIONS.has(tokens[1])
  )
    tokens.shift();
  else if (
    tokens.length > 3 &&
    /^\d+$/.test(tokens[0]) &&
    DIRECTIONS.has(tokens[1])
  )
    tokens.shift();
  if (tokens.length > 1 && DIRECTIONS.has(tokens[0])) tokens.shift();
  return tokens.join(" ");
}
export function bearing(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) {
  const east = (to.lng - from.lng) * Math.cos((from.lat * Math.PI) / 180),
    north = to.lat - from.lat;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}
// Road segments bucketed into a grid, so each lookup checks only nearby ones.
export function roadIndex(roads: Road[], cell = 0.004) {
  const grid = new Map<string, { road: Road; i: number }[]>();
  for (const road of roads)
    for (let i = 0; i + 1 < road.line.length; i++) {
      const [x1, y1] = road.line[i],
        [x2, y2] = road.line[i + 1];
      for (
        let cx = Math.floor(Math.min(x1, x2) / cell);
        cx <= Math.floor(Math.max(x1, x2) / cell);
        cx++
      )
        for (
          let cy = Math.floor(Math.min(y1, y2) / cell);
          cy <= Math.floor(Math.max(y1, y2) / cell);
          cy++
        ) {
          const key = `${cx},${cy}`;
          let bucket = grid.get(key);
          if (!bucket) grid.set(key, (bucket = []));
          bucket.push({ road, i });
        }
    }
  return { grid, cell };
}
export function streetView(
  index: ReturnType<typeof roadIndex>,
  property: { lat: number; lng: number; address: string },
  maxMeters = 300,
): StreetView | null {
  const { grid, cell } = index,
    scale = Math.cos((property.lat * Math.PI) / 180),
    reach = Math.ceil(maxMeters / METERS_PER_DEGREE / (cell * scale)) + 1,
    cx = Math.floor(property.lng / cell),
    cy = Math.floor(property.lat / cell),
    wanted = streetKey(property.address);
  let best: StreetView | null = null;
  for (let dx = -reach; dx <= reach; dx++)
    for (let dy = -reach; dy <= reach; dy++)
      for (const { road, i } of grid.get(`${cx + dx},${cy + dy}`) || []) {
        // Work in meters on a flat patch around the property.
        const ax = (road.line[i][0] - property.lng) * scale * METERS_PER_DEGREE,
          ay = (road.line[i][1] - property.lat) * METERS_PER_DEGREE,
          bx = (road.line[i + 1][0] - property.lng) * scale * METERS_PER_DEGREE,
          by = (road.line[i + 1][1] - property.lat) * METERS_PER_DEGREE,
          length2 = (bx - ax) ** 2 + (by - ay) ** 2,
          t =
            length2 === 0
              ? 0
              : Math.min(
                  1,
                  Math.max(0, (-ax * (bx - ax) - ay * (by - ay)) / length2),
                ),
          px = ax + t * (bx - ax),
          py = ay + t * (by - ay),
          distance = Math.hypot(px, py);
        if (distance > maxMeters) continue;
        const named = Boolean(wanted) && streetKey(road.name) === wanted;
        // The address street wins over a closer road behind or beside the lot.
        if (
          best &&
          (best.named !== named ? best.named : best.distance <= distance)
        )
          continue;
        const point = {
          lat: property.lat + py / METERS_PER_DEGREE,
          lng: property.lng + px / (scale * METERS_PER_DEGREE),
        };
        best = {
          ...point,
          heading: bearing(point, property),
          distance,
          named,
        };
      }
  return best;
}
