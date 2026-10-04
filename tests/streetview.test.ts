import { test } from "node:test";
import assert from "node:assert/strict";
import {
  streetKey,
  bearing,
  roadIndex,
  streetView,
} from "../server/streetview.js";

test("address streets and road names reduce to the same key", () => {
  const same: [string, string][] = [
    ["1652 APACHE WAY", "Apache Way"],
    ["3147 N 2575 W", "2575 West"],
    ["3147 N 2575 W", "North 2575 West"],
    ["218 W 5000 S", "West 5000 South"],
    ["558 W HARRISVILLE RD", "West Harrisville Road"],
    ["450 12TH ST", "12th Street"],
    ["100 N MAIN ST", "Main Street"],
    ["77 E OAK CIR", "Oak Circle"],
  ];
  for (const [address, road] of same)
    assert.equal(streetKey(address), streetKey(road), `${address} / ${road}`);
  assert.equal(streetKey("3147 N 2575 W"), "2575 W");
  assert.notEqual(streetKey("1652 APACHE WAY"), streetKey("Navajo Drive"));
  assert.notEqual(streetKey("3147 N 2575 W"), streetKey("2550 West"));
});
test("bearing is measured clockwise from north", () => {
  const here = { lat: 41.2, lng: -112 };
  assert.equal(Math.round(bearing(here, { lat: 41.201, lng: -112 })), 0);
  assert.equal(Math.round(bearing(here, { lat: 41.2, lng: -111.999 })), 90);
  assert.equal(Math.round(bearing(here, { lat: 41.199, lng: -112 })), 180);
  assert.equal(Math.round(bearing(here, { lat: 41.2, lng: -112.001 })), 270);
});
test("street view stands on the address street and faces the property", () => {
  // A lot between two east-west streets: Oak Street 60 m north, a nearer
  // unnamed-to-us back street 20 m south. The address is on Oak Street.
  const lat = 41.2,
    lng = -112,
    north = lat + 60 / 111320,
    south = lat - 20 / 111320;
  const index = roadIndex([
    {
      name: "Oak Street",
      line: [
        [lng - 0.005, north],
        [lng + 0.005, north],
      ],
    },
    {
      name: "Pine Street",
      line: [
        [lng - 0.005, south],
        [lng + 0.005, south],
      ],
    },
  ]);
  const front = streetView(index, { lat, lng, address: "120 W OAK ST" })!;
  assert.equal(front.named, true);
  assert.ok(Math.abs(front.lat - north) < 1e-7);
  assert.ok(Math.abs(front.lng - lng) < 1e-7);
  // Standing north of the lot, the camera looks south.
  assert.equal(Math.round(front.heading), 180);
  assert.equal(Math.round(front.distance), 60);

  // With no street name to go by, the nearest road is used and faces north.
  const back = streetView(index, { lat, lng, address: "" })!;
  assert.equal(back.named, false);
  assert.equal(Math.round(back.heading), 0);
  assert.equal(Math.round(back.distance), 20);

  // Past the end of a road, the camera stands at the road's end.
  const corner = streetView(index, {
    lat,
    lng: lng + 0.006,
    address: "9 OAK ST",
  })!;
  assert.ok(Math.abs(corner.lng - (lng + 0.005)) < 1e-7);
  assert.ok(corner.heading > 90 && corner.heading < 180);

  assert.equal(
    streetView(index, { lat: lat + 0.02, lng, address: "1 OAK ST" }),
    null,
  );
});
