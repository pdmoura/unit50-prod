import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detail, listProperties } from "../server/db.js";
import { runImport } from "../server/importer.js";
import {
  parseCurrentTaxes,
  parseCharacteristics,
  fetchCountyDetails,
  runCountyDetails,
  detailsRun,
  type PageFetcher,
} from "../server/parcelsearch.js";
import { feature, source } from "./fixtures.js";
import { withDb, startImport } from "./helpers.js";

const page = (name: string) =>
  readFileSync(
    new URL(`./parcelsearch-pages/${name}.html`, import.meta.url),
    "utf8",
  );
const pages: PageFetcher = async (path) => {
  if (path.includes("009999999"))
    return page(
      path.startsWith("current-taxes")
        ? "current-taxes-unknown"
        : "property-characteristics-unknown",
    );
  return page(
    path.startsWith("current-taxes")
      ? "current-taxes"
      : "property-characteristics",
  );
};

test("parses Parcel Search current taxes", () => {
  const t = parseCurrentTaxes(page("current-taxes"));
  assert.equal(t.owner, "JANE Q SAMPLE FAMILY TRUST");
  assert.equal(t.ownerAsOf, "1/1/2026");
  assert.equal(t.taxYear, 2026);
  assert.equal(t.loanCompany, null);
  assert.equal(t.taxArea, 25);
  assert.equal(t.marketValue, 480207);
  assert.equal(t.taxableValue, 264113);
  assert.equal(t.taxRate, 0.011991);
  assert.equal(t.netAssessment, 3166.98);
  assert.equal(t.directTotal, 225.73);
  assert.equal(t.penalty, null);
  assert.equal(t.balance, 3392.71);
  assert.deepEqual(t.directCharges, [
    {
      type: "19",
      description: "Weber Basin Wtr Chg",
      amount: 225.73,
      status: "ORIG",
    },
  ]);
  assert.deepEqual(t.payments, []);
  assert.deepEqual(parseCurrentTaxes(page("current-taxes-paid")).payments, [
    {
      date: "November 18, 2025",
      payee: "Jane Q Sample",
      amount: -3360.22,
      status: "Regular",
    },
  ]);
  assert.throws(
    () => parseCurrentTaxes(page("current-taxes-unknown")),
    /no tax record/,
  );
});

test("parses Parcel Search property characteristics with every building", () => {
  const c = parseCharacteristics(page("property-characteristics"));
  assert.equal(c.acres, 0.21);
  assert.equal(c.greenbelt, false);
  assert.equal(c.landType, "Unknown");
  assert.equal(c.neighborhood, "324");
  assert.equal(c.buildings.length, 3);
  assert.deepEqual(c.buildings[0], {
    number: 1,
    type: "RESIDENTIAL",
    style: "Bi-Level",
    exterior: "Frame: Plywood Hardboard",
    roof: "Shingle",
    quality: "Average Plus (3.5)",
    year: 1976,
    livingSqft: 1487,
    percentComplete: 100,
    basementSqft: 675,
    basementFinishPct: 95,
  });
  assert.equal(c.buildings[2].livingSqft, 120);
  assert.equal(c.sketches.length, 1);
  assert.match(c.platMaps[0], /Platmaps\/07-172\.PDF$/);
  assert.throws(
    () => parseCharacteristics(page("property-characteristics-unknown")),
    /no characteristics/,
  );
});

test("import stores owner and assessment fields; owner is searchable and does not cause conflicts", () =>
  withDb(async (sql) => {
    await startImport(sql, "a");
    const county = {
      NAME_ONE: "SAMPLE, JANE",
      STREET: "PO BOX 1",
      CITY_STATE: "OGDEN UT",
      ZIPCODE: "84401",
      TOT_MARKET: 480207,
      TOT_TAXABLE: 264113,
      YR_RATE: 0.0119909998,
      TotalCharge: 3392.71,
      TaxYear: 2026,
      LEA: 324,
      landgrossacrecount: 0.21,
    };
    await runImport(
      sql,
      "a",
      source([
        feature(1, "001234567", county),
        // Same parcel, second geometry with a different tax snapshot: core
        // attributes match, so it must not be flagged as a conflict.
        feature(2, "001234567", { ...county, TOT_MARKET: 1 }),
      ]),
    );
    const p = await detail(sql, "001234567");
    assert.equal(p.conflict, false);
    assert.equal(p.owner, "SAMPLE, JANE");
    assert.equal(p.mailCity, "OGDEN UT");
    assert.equal(p.marketValue, 480207);
    assert.equal(p.taxRate, 0.011991);
    assert.equal(p.taxYear, 2026);
    assert.equal(p.neighborhood, "324");
    assert.equal(p.acres, 0.21);
    assert.equal(p.county, null);
    assert.match(p.parcelSearchUrl, /current-taxes\.php\?id=001234567$/);
    assert.equal((await listProperties(sql, { q: "jane" })).total, 1);
  }));

test("Parcel Search run fetches missing parcels, records failures and resumes", () =>
  withDb(async (sql) => {
    await startImport(sql, "a");
    await runImport(
      sql,
      "a",
      source([feature(1, "001234567"), feature(2, "009999999")]),
    );
    const start = (id: string, mode = "missing") =>
      sql`INSERT INTO details_runs (id, state, mode, started_at) VALUES (${id}, 'running', ${mode}, ${new Date().toISOString()})`;
    await start("r1");
    await runCountyDetails(sql, "r1", { fetcher: pages, delayMs: 0 });
    assert.equal((await detailsRun(sql, "r1"))?.state, "completed");
    assert.equal((await detailsRun(sql, "r1"))?.processed, 2);
    assert.equal((await detailsRun(sql, "r1"))?.failed, 1);
    const ok = (await detail(sql, "001234567")).county!;
    assert.equal(ok.state, "ok");
    assert.equal(ok.data!.characteristics.buildings.length, 3);
    assert.equal(ok.data!.taxes.directCharges[0].amount, 225.73);
    assert.equal((await detail(sql, "009999999")).county!.state, "error");

    // A second run only retries what failed.
    let calls = 0;
    const counting: PageFetcher = (path) => {
      calls++;
      return pages(path);
    };
    await start("r2");
    await runCountyDetails(sql, "r2", { fetcher: counting, delayMs: 0 });
    assert.equal((await detailsRun(sql, "r2"))?.total, 1);
    assert.equal(calls, 2);

    // A failed refresh keeps the last good data.
    const failing: PageFetcher = async () => {
      throw new Error("offline");
    };
    await start("r3", "refresh");
    await runCountyDetails(sql, "r3", {
      fetcher: failing,
      delayMs: 0,
      mode: "refresh",
      refreshDays: -1,
    });
    const kept = (await detail(sql, "001234567")).county!;
    assert.equal(kept.state, "error");
    assert.equal(kept.error, "offline");
    assert.equal(kept.data!.taxes.owner, "JANE Q SAMPLE FAMILY TRUST");

    // Stopping ends the run after in-flight parcels.
    await start("r4", "refresh");
    const stopper: PageFetcher = async (path) => {
      await sql`UPDATE details_runs SET state='stopping' WHERE id='r4'`;
      return pages(path);
    };
    await runCountyDetails(sql, "r4", {
      fetcher: stopper,
      delayMs: 0,
      mode: "refresh",
      refreshDays: -1,
      concurrency: 1,
    });
    assert.equal((await detailsRun(sql, "r4"))?.state, "stopped");
    assert.equal((await detailsRun(sql, "r4"))?.processed, 1);
  }));

test("fetchCountyDetails reads both pages", async () => {
  const d = await fetchCountyDetails("001234567", pages);
  assert.equal(d.taxes.owner, "JANE Q SAMPLE FAMILY TRUST");
  assert.equal(d.characteristics.buildings[0].style, "Bi-Level");
});
