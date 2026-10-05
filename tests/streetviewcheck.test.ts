import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signUrl,
  metersBetween,
  checkProperty,
  StreetViewDenied,
  type CheckOptions,
} from "../server/streetviewcheck.js";
import { withDb } from "./helpers.js";

const KEY = "test-key-123";
// A stand-in for Google: answers each request from a list, and records what
// was asked. Nothing leaves this computer.
function google(answers: (object | number | Error)[]) {
  const asked: URL[] = [];
  const fetcher = (async (url: string | URL) => {
    asked.push(new URL(String(url)));
    const answer = answers.shift();
    if (answer === undefined) throw new Error("unexpected request");
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number")
      return new Response("{}", { status: answer });
    return new Response(JSON.stringify(answer));
  }) as typeof fetch;
  const options: CheckOptions = { key: KEY, fetcher, backoffMs: () => 0 };
  return { asked, options, left: answers };
}
// A lot at 41.2, -112 whose road point is 20 m north of it.
const lot = {
  id: "190880007",
  lat: 41.2,
  lng: -112,
  streetLat: 41.2 + 20 / 111320,
  streetLng: -112,
};
const pano = (metersEast: number, from = lot.streetLat) => ({
  status: "OK",
  pano_id: "PANO_abc",
  date: "2024-06",
  location: {
    lat: from,
    lng: -112 + metersEast / (111320 * Math.cos((41.2 * Math.PI) / 180)),
  },
});

test("URL signature matches Google's documented example", () => {
  assert.equal(
    signUrl(
      "/maps/api/geocode/json?address=New+York&client=clientID",
      "vNIXE0xscrmjlyV-12Nj_BvUPaw=",
    ),
    "/maps/api/geocode/json?address=New+York&client=clientID&signature=chaRF2hTJKOScPr-RQCEhZbSzIE=",
  );
  assert.equal(
    Math.round(
      metersBetween({ lat: 41.2, lng: -112 }, { lat: 41.201, lng: -112 }),
    ),
    111,
  );
});
test("a picture at the expected spot is recorded as available", async () => {
  const g = google([pano(6)]);
  assert.deepEqual(await checkProperty(lot, g.options), {
    outcome: "available",
    pano: "PANO_abc",
    detail: "picture 6 m from the expected spot",
  });
  // One request, from the road point, outdoor imagery only, never the parcel.
  assert.equal(g.asked.length, 1);
  const q = g.asked[0].searchParams;
  assert.equal(
    g.asked[0].origin + g.asked[0].pathname,
    "https://maps.googleapis.com/maps/api/streetview/metadata",
  );
  assert.equal(q.get("location"), `${lot.streetLat.toFixed(6)},-112.000000`);
  assert.equal(q.get("radius"), "50");
  assert.equal(q.get("source"), "outdoor");
  assert.equal(q.get("key"), KEY);
  assert.equal(q.get("signature"), null);

  const signed = google([pano(0)]);
  await checkProperty(lot, {
    ...signed.options,
    secret: "vNIXE0xscrmjlyV-12Nj_BvUPaw=",
  });
  assert.match(signed.asked[0].searchParams.get("signature")!, /^[\w-]+=*$/);
});
test("a picture further down the road is uncertain, not attached", async () => {
  const g = google([pano(40)]);
  const result = await checkProperty(lot, g.options);
  assert.equal(result.outcome, "uncertain");
  assert.match(result.detail, /40 m from the expected spot/);
});
test("no Street View is recorded only when a wider look finds nothing", async () => {
  const none = google([{ status: "ZERO_RESULTS" }, { status: "ZERO_RESULTS" }]);
  assert.deepEqual(await checkProperty(lot, none.options), {
    outcome: "none",
    detail: "no picture within 150 m",
  });
  // The second look is from the parcel itself, with the wider radius.
  assert.equal(
    none.asked[1].searchParams.get("location"),
    "41.200000,-112.000000",
  );
  assert.equal(none.asked[1].searchParams.get("radius"), "150");

  const nearby = google([{ status: "ZERO_RESULTS" }, pano(90, lot.lat)]);
  const result = await checkProperty(lot, nearby.options);
  assert.equal(result.outcome, "uncertain");
  assert.match(result.detail, /no picture in front; nearest is 90 m/);

  // Without a road point there is no "front" to confirm, so it is never available.
  const noRoad = google([pano(5, lot.lat)]);
  const blind = await checkProperty(
    { ...lot, streetLat: null, streetLng: null },
    noRoad.options,
  );
  assert.equal(blind.outcome, "uncertain");
  assert.match(blind.detail, /no road point/);
  assert.equal(noRoad.asked.length, 1);
});
test("failures are never mistaken for missing coverage", async () => {
  // Server errors and rate limits are retried, then the answer is used.
  const flaky = google([
    500,
    { status: "OVER_QUERY_LIMIT" },
    { status: "UNKNOWN_ERROR" },
    pano(3),
  ]);
  assert.equal((await checkProperty(lot, flaky.options)).outcome, "available");
  assert.equal(flaky.asked.length, 4);

  // Retries are bounded; the outcome is "failed", not "none".
  const down = google([503, 503, 503, 503, 503]);
  const failed = await checkProperty(lot, { ...down.options, retries: 2 });
  assert.deepEqual(failed, {
    outcome: "failed",
    detail: "HTTP 503 after 3 attempts",
  });
  assert.equal(down.left.length, 2);

  const timeout = Object.assign(new Error("slow"), { name: "TimeoutError" });
  const slow = google([timeout, timeout]);
  const timedOut = await checkProperty(lot, { ...slow.options, retries: 1 });
  assert.deepEqual(timedOut, {
    outcome: "failed",
    detail: "timed out after 2 attempts",
  });

  // A network error whose message carries the URL must not leak the key.
  const leaky = google([
    new TypeError(`fetch failed for https://maps.googleapis.com/?key=${KEY}`),
  ]);
  const hidden = await checkProperty(lot, { ...leaky.options, retries: 0 });
  assert.equal(hidden.outcome, "failed");
  assert.ok(!hidden.detail.includes(KEY));

  const odd = google([{ status: "INVALID_REQUEST" }]);
  assert.deepEqual(await checkProperty(lot, odd.options), {
    outcome: "failed",
    detail: "unexpected answer: INVALID_REQUEST",
  });

  // A failure while confirming "nothing nearby" is still a failure.
  const half = google([{ status: "ZERO_RESULTS" }, 500]);
  assert.equal(
    (await checkProperty(lot, { ...half.options, retries: 0 })).outcome,
    "failed",
  );
});
test("a refused API key stops the run instead of failing each property", async () => {
  const denied = google([
    {
      status: "REQUEST_DENIED",
      error_message: "The provided API key is invalid.",
    },
  ]);
  await assert.rejects(
    checkProperty(lot, denied.options),
    (error: Error) =>
      error instanceof StreetViewDenied &&
      /API key is invalid/.test(error.message),
  );
  assert.equal(denied.asked.length, 1);
  await assert.rejects(
    checkProperty(lot, google([403]).options),
    StreetViewDenied,
  );
});
test("the database accepts only the two recorded answers", async () => {
  await withDb(async (sql) => {
    const columns =
      await sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='properties' AND column_name LIKE 'street_view%' ORDER BY 1`;
    assert.deepEqual(
      columns.map((c) => [c.columnName, c.isNullable]),
      [
        ["street_view_pano", "YES"],
        ["street_view_status", "YES"],
      ],
    );
    const [check] =
      await sql`SELECT pg_get_constraintdef(c.oid) AS rule FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname='properties' AND pg_get_constraintdef(c.oid) LIKE '%street_view_status%'`;
    assert.match(check.rule, /available/);
    assert.match(check.rule, /none/);
    assert.doesNotMatch(check.rule, /failed|uncertain/);
  });
});
