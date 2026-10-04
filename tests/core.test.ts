import { test } from "node:test";
import assert from "node:assert/strict";
import { priorityFor, utahToday } from "../shared/types.js";
import {
  openDb,
  detail,
  addVisit,
  addFollowUp,
  updateProspect,
  updateFollowUp,
  followUps,
  importRun,
  validDate,
  listProperties,
} from "../server/db.js";
import { runImport, normalize } from "../server/importer.js";
import { feature, source } from "./fixtures.js";
import { createApp } from "../server/app.js";
import {
  TEST_DATABASE_URL,
  createSchema,
  dropSchema,
  withDb,
  startImport,
} from "./helpers.js";

test("age boundaries, fractions, missing years and Utah calendar dates", () => {
  assert.deepEqual(priorityFor(1986, false, 2026), {
    priority: "High",
    age: 40,
  });
  assert.deepEqual(priorityFor(1986.1, false, 2026), {
    priority: "Medium",
    age: 39,
  });
  assert.deepEqual(priorityFor(2006, false, 2026), {
    priority: "Medium",
    age: 20,
  });
  assert.deepEqual(priorityFor(2006.1, false, 2026), {
    priority: "Low",
    age: 19,
  });
  for (const y of [null, 0, 1599, 2027, NaN, Infinity])
    assert.equal(priorityFor(y, false, 2026).priority, "Unknown");
  assert.equal(priorityFor(1900, true, 2026).priority, "Unknown");
  assert.equal(utahToday(new Date("2026-10-02T01:00:00Z")), "2026-10-01");
  assert.equal(validDate("2025-02-29"), false);
  assert.equal(validDate("2024-02-29"), true);
});
test("import preserves leading zeros, separates duplicate geometries and flags conflict", () =>
  withDb(async (sql) => {
    const thisYear = Number(utahToday().slice(0, 4));
    await startImport(sql, "a");
    await runImport(
      sql,
      "a",
      source([
        feature(),
        feature(2),
        feature(3, "009999999", { WGT_AVE_RI_YB: 1960 }),
        feature(4, "009999999", { WGT_AVE_RI_YB: 1980 }),
        // A fractional year just under 40: the age filter must use whole years.
        feature(5, "005555555", { WGT_AVE_RI_YB: thisYear - 39.9 }),
      ]),
    );
    assert.equal((await importRun(sql, "a"))?.state, "completed");
    assert.equal((await importRun(sql, "a"))?.parcels, 3);
    assert.equal((await detail(sql, "001234567")).geometries.length, 2);
    assert.equal((await detail(sql, "001234567")).issues.length, 0);
    assert.equal((await detail(sql, "009999999")).priority, "Unknown");
    assert.equal((await detail(sql, "009999999")).conflict, true);
    assert.equal((await detail(sql, "005555555")).age, 39);
    assert.equal((await listProperties(sql, { priority: "Unknown" })).total, 1);
    assert.equal((await listProperties(sql, { minAge: "40" })).total, 1);
    assert.equal((await listProperties(sql, { maxAge: "39" })).total, 1);
    const p = normalize(feature());
    assert.ok(p.lng! >= -111.98 && p.lng! <= -111.979);
    assert.ok(p.lat! >= 41.23 && p.lat! <= 41.231);
  }));
test("failed batches leave the active dataset and CRM intact; removed parcels become inactive", () =>
  withDb(async (sql) => {
    await startImport(sql, "a");
    await runImport(sql, "a", source([feature(), feature(2, "002222222")]));
    await addVisit(sql, "001234567", "Interested", "Original conversation");
    const f = await addFollowUp(sql, "001234567", "2026-11-05", "Call back");
    await startImport(sql, "b");
    await runImport(sql, "b", {
      ids: async () => [1, 2],
      batch: async () => [feature()],
    });
    assert.equal((await importRun(sql, "b"))?.state, "failed");
    assert.equal((await listProperties(sql, {})).total, 2);
    assert.equal((await detail(sql, "001234567")).visits.length, 1);
    await startImport(sql, "c");
    await runImport(
      sql,
      "c",
      source([feature(8, "002222222", { PROP_STREET: "UPDATED ST" })]),
    );
    assert.equal((await detail(sql, "001234567")).active, false);
    assert.equal((await detail(sql, "002222222")).address, "UPDATED ST");
    assert.equal((await followUps(sql))[0].id, f);
    assert.equal((await followUps(sql))[0].dueDate, "2026-11-05");
    assert.equal((await listProperties(sql, {})).total, 1);
    assert.equal((await listProperties(sql, { active: "all" })).total, 2);
    await assert.rejects(
      addFollowUp(sql, "001234567", "2026-11-06", ""),
      /no longer active/,
    );
  }));
test("do not contact cancels pending returns atomically and prevents rescheduling or new visits", () =>
  withDb(async (sql) => {
    await startImport(sql, "a");
    await runImport(sql, "a", source([feature()]));
    const f = await addFollowUp(sql, "001234567", "2026-11-05", "First");
    const completed = await addFollowUp(sql, "001234567", "2026-11-06", "Done");
    await updateFollowUp(sql, completed, { state: "completed" });
    await addVisit(
      sql,
      "001234567",
      "Do not contact",
      "Requested no more contact",
    );
    const tasks = await followUps(sql);
    assert.equal(tasks.find((t) => t.id === f)?.state, "cancelled");
    assert.equal(tasks.find((t) => t.id === completed)?.state, "completed");
    await assert.rejects(
      addFollowUp(sql, "001234567", "2026-11-07", ""),
      /Do not contact/,
    );
    await assert.rejects(
      updateFollowUp(sql, f, { state: "pending" }),
      /Do not contact/,
    );
    await assert.rejects(
      addVisit(sql, "001234567", "Interested", ""),
      /Do not contact/,
    );
    // The refused visit must not leave a partial record behind.
    assert.equal((await detail(sql, "001234567")).visits.length, 1);
    await updateProspect(sql, "001234567", "Interested");
    await updateFollowUp(sql, f, { dueDate: "2026-12-01", state: "pending" });
    assert.equal(
      (await followUps(sql)).find((t) => t.id === f)?.dueDate,
      "2026-12-01",
    );
  }));
test("HTTP flow survives server restart, validates inputs and returns matching map/list filters", async () => {
  const schema = await createSchema();
  const options = {
    databaseUrl: TEST_DATABASE_URL,
    schema,
    allowImports: false,
    cloudinary: null,
    auth: null,
  };
  let app: Awaited<ReturnType<typeof createApp>> | null = null;
  try {
    app = await createApp(options);
    await app.close();
    const sql = openDb(TEST_DATABASE_URL, schema);
    await startImport(sql, "seed");
    await runImport(
      sql,
      "seed",
      source([feature(), feature(2, "000000002", { WGT_AVE_RI_YB: 2015 })]),
    );
    await sql.end();
    app = await createApp(options);
    const visit = await app.inject({
      method: "POST",
      url: "/api/properties/001234567/visits",
      payload: { result: "Interested", notes: "Persist after restart" },
    });
    assert.equal(visit.statusCode, 201);
    const task = await app.inject({
      method: "POST",
      url: "/api/follow-ups",
      payload: {
        propertyId: "001234567",
        dueDate: "2026-11-05",
        notes: "Return",
      },
    });
    assert.equal(task.statusCode, 201);
    const map = await app.inject(
      "/api/map?bbox=-112,41,-111,42&zoom=18&priority=High",
    );
    assert.equal(map.statusCode, 200);
    assert.equal(map.json().features.length, 1);
    const list = await app.inject("/api/properties?priority=High");
    assert.equal(list.json().total, 1);
    assert.equal(map.json().features[0].properties.id, list.json().items[0].id);
    // OpenStreetMap blocks map tiles requested without a referrer.
    assert.equal(
      (await app.inject("/api/health")).headers["referrer-policy"],
      "strict-origin-when-cross-origin",
    );
    const summary = (await app.inject("/api/summary")).json();
    assert.deepEqual(
      [summary.total, summary.high, summary.mapped, summary.visited],
      [2, 1, 2, 1],
    );
    assert.equal(summary.photosEnabled, false);
    assert.equal(
      (await app.inject("/api/map?bbox=abc&zoom=18")).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/api/properties?status=invalid")).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/api/properties?minAge=100&maxAge=2")).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/follow-ups",
          payload: { propertyId: "001234567", dueDate: "2026-02-30" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/summary",
          headers: { host: "attacker.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/summary",
          headers: { origin: "https://attacker.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject("/api/properties?q=%27%20OR%201%3D1--")).json().total,
      0,
    );
    // Search is case-insensitive and treats % and _ as plain characters.
    assert.equal(
      (await app.inject("/api/properties?q=test%20st")).json().total,
      2,
    );
    assert.equal((await app.inject("/api/properties?q=%25")).json().total, 0);
    assert.equal(
      (await app.inject("/api/properties/001234567/photos/ticket")).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/properties/001234567/photos/ticket",
        })
      ).statusCode,
      503,
    );
    await app.close();
    app = null;
    const restart = openDb(TEST_DATABASE_URL, schema);
    await startImport(restart, "interrupted");
    await restart.end();
    app = await createApp(options);
    const saved = (await app.inject("/api/properties/001234567")).json();
    assert.equal(saved.status, "Interested");
    assert.equal(saved.visits[0].notes, "Persist after restart");
    assert.equal(saved.followUps[0].id, task.json().id);
    assert.equal(saved.nextFollowUp, "2026-11-05");
    assert.deepEqual(saved.photos, []);
    assert.equal(
      (await app.inject("/api/imports/interrupted")).json().state,
      "failed",
    );
  } finally {
    if (app) await app.close();
    await dropSchema(schema);
  }
});
