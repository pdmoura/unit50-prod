import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { openDb } from "../server/db.js";
import { runImport } from "../server/importer.js";
import { createApp } from "../server/app.js";
import { areaFor, allowed, accountFrom } from "../server/access.js";
import {
  verifyWebhook,
  parseLeadEvent,
  matchProperty,
} from "../server/leads.js";
import type { TokenVerifier } from "../server/auth.js";
import { feature, source } from "./fixtures.js";
import {
  TEST_DATABASE_URL,
  createSchema,
  dropSchema,
  startImport,
  withDb,
} from "./helpers.js";

const SECRET = "website-test-secret";
const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({
  "x-unit50-timestamp": String(ts),
  "x-unit50-signature": createHmac("sha256", SECRET)
    .update(`${ts}.${body}`)
    .digest("hex"),
});
// One sign-in token per person; the verifier stands in for Supabase.
const people = ["admin@unit50.com", "ana@unit50.com", "ben@unit50.com"];
const verify: TokenVerifier = async (token) =>
  people.includes(token) ? { id: token, email: token } : null;

async function team() {
  const schema = await createSchema();
  const sql = openDb(TEST_DATABASE_URL, schema);
  const app = await createApp({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    allowImports: false,
    cloudinary: null,
    auth: { url: "https://auth.example", key: "pk", verify },
    leadsWebhookSecret: SECRET,
  });
  await startImport(sql, "t");
  await runImport(
    sql,
    "t",
    source([
      feature(1, "001234567", {
        PROP_STREET: "3147 N 2575 W",
        PROP_ZIP: "84404",
      }),
      feature(2, "002222222", {
        PROP_STREET: "3151 N 2575 W",
        PROP_ZIP: "84404",
      }),
    ]),
  );
  await sql`INSERT INTO app_users (email, role) VALUES ('admin@unit50.com', 'admin'), ('ana@unit50.com', 'rep'), ('ben@unit50.com', 'rep')`;
  const call = (
    as: string | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        host: "unit50.onrender.com",
        ...(as ? { authorization: `Bearer ${as}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const webhook = (body: string, headers = sign(body)) =>
    app.inject({
      method: "POST",
      url: "/api/webhooks/website",
      headers: {
        host: "unit50.onrender.com",
        "content-type": "application/json",
        ...headers,
      },
      payload: body,
    });
  return {
    sql,
    call,
    webhook,
    async close() {
      await sql.end();
      await app.close();
      await dropSchema(schema);
    },
  };
}

test("each API call belongs to one module, and only admins reach the admin panel", () => {
  assert.equal(areaFor("GET", "/api/map"), "map");
  assert.equal(areaFor("GET", "/api/properties"), "map");
  assert.equal(areaFor("GET", "/api/properties/1"), "property");
  assert.equal(areaFor("POST", "/api/properties/1/visits"), "property");
  assert.equal(areaFor("GET", "/api/follow-ups"), "follow-ups");
  assert.equal(areaFor("POST", "/api/follow-ups"), "property");
  assert.equal(areaFor("PATCH", "/api/follow-ups/1"), "property");
  assert.equal(areaFor("GET", "/api/leads"), "leads");
  assert.equal(areaFor("PATCH", "/api/leads/1"), "leads");
  assert.equal(areaFor("GET", "/api/imports"), "super-admin");
  assert.equal(areaFor("POST", "/api/imports"), "super-admin");
  assert.equal(areaFor("GET", "/api/data/issues"), "super-admin");
  assert.equal(areaFor("GET", "/api/county-details"), "super-admin");
  assert.equal(areaFor("POST", "/api/county-details/runs"), "super-admin");
  assert.equal(areaFor("POST", "/api/properties/1/county"), "super-admin");
  assert.equal(areaFor("GET", "/api/admin/users"), "admin");
  assert.equal(areaFor("GET", "/api/summary"), "signed-in");
  const rep = accountFrom({ email: "a@b.co", role: "rep", modules: ["leads"] });
  assert.equal(allowed(rep, "leads"), true);
  assert.equal(allowed(rep, "map"), false);
  assert.equal(allowed(rep, "property"), true);
  assert.equal(allowed(rep, "admin"), false);
  const admin = accountFrom({ email: "a@b.co", role: "admin", modules: [] });
  assert.deepEqual(admin.modules, ["map", "follow-ups", "leads"]);
  // Imports belong to the super admin alone, not to admins.
  assert.equal(allowed(admin, "super-admin"), false);
  const owner = accountFrom({
    email: "a@b.co",
    role: "rep",
    modules: [],
    superAdmin: true,
  });
  assert.equal(owner.role, "admin");
  assert.equal(allowed(owner, "super-admin"), true);
  assert.equal(allowed(owner, "admin"), true);
  assert.equal(allowed(admin, "admin"), true);
});

test("admins manage the team; turning a module off applies on the next request", async () => {
  const t = await team();
  try {
    assert.equal(
      (await t.call("ana@unit50.com", "GET", "/api/admin/users")).statusCode,
      403,
    );
    const list = (
      await t.call("admin@unit50.com", "GET", "/api/admin/users")
    ).json();
    assert.deepEqual(
      list.items.map((m: { email: string; role: string }) => [m.email, m.role]),
      [
        ["admin@unit50.com", "admin"],
        ["ana@unit50.com", "rep"],
        ["ben@unit50.com", "rep"],
      ],
    );
    // Ana keeps only the map.
    const changed = await t.call(
      "admin@unit50.com",
      "PATCH",
      "/api/admin/users/ana@unit50.com",
      {
        modules: ["map"],
      },
    );
    assert.equal(changed.statusCode, 200);
    assert.deepEqual(
      (await t.call("ana@unit50.com", "GET", "/api/me")).json().modules,
      ["map"],
    );
    assert.equal(
      (await t.call("ana@unit50.com", "GET", "/api/properties")).statusCode,
      200,
    );
    assert.equal(
      (await t.call("ana@unit50.com", "GET", "/api/properties/001234567"))
        .statusCode,
      200,
    );
    for (const url of [
      "/api/follow-ups",
      "/api/leads",
      "/api/imports",
      "/api/county-details",
    ])
      assert.equal(
        (await t.call("ana@unit50.com", "GET", url)).statusCode,
        403,
        url,
      );
    // Ben with only leads can still open a lead's property, but not the map.
    await t.call(
      "admin@unit50.com",
      "PATCH",
      "/api/admin/users/ben@unit50.com",
      { modules: ["leads"] },
    );
    assert.equal(
      (await t.call("ben@unit50.com", "GET", "/api/properties/001234567"))
        .statusCode,
      200,
    );
    assert.equal(
      (await t.call("ben@unit50.com", "GET", "/api/properties")).statusCode,
      403,
    );
    assert.equal(
      (await t.call("ben@unit50.com", "GET", "/api/leads")).statusCode,
      200,
    );
    // Bad input is refused.
    assert.equal(
      (
        await t.call(
          "admin@unit50.com",
          "PATCH",
          "/api/admin/users/ana@unit50.com",
          { modules: ["everything"] },
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await t.call("admin@unit50.com", "POST", "/api/admin/users", {
          email: "not-an-email",
        })
      ).statusCode,
      400,
    );
    // Adding a person: a rep with every module, lower-cased; adding twice is refused.
    const added = await t.call("admin@unit50.com", "POST", "/api/admin/users", {
      email: " Cara@Unit50.com ",
    });
    assert.equal(added.statusCode, 201);
    assert.deepEqual(
      added
        .json()
        .items.find((m: { email: string }) => m.email === "cara@unit50.com")
        .modules,
      ["map", "follow-ups", "leads"],
    );
    assert.equal(
      (
        await t.call("admin@unit50.com", "POST", "/api/admin/users", {
          email: "cara@unit50.com",
        })
      ).statusCode,
      409,
    );
    // An admin cannot lock themselves out, and the last admin cannot be removed.
    assert.equal(
      (
        await t.call(
          "admin@unit50.com",
          "PATCH",
          "/api/admin/users/admin@unit50.com",
          { role: "rep" },
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await t.call(
          "admin@unit50.com",
          "DELETE",
          "/api/admin/users/admin@unit50.com",
        )
      ).statusCode,
      409,
    );
    // A second admin can be made; then demoting the first is allowed.
    await t.call(
      "admin@unit50.com",
      "PATCH",
      "/api/admin/users/cara@unit50.com",
      { role: "admin" },
    );
    people.push("cara@unit50.com");
    assert.equal(
      (
        await t.call(
          "cara@unit50.com",
          "PATCH",
          "/api/admin/users/admin@unit50.com",
          { role: "rep" },
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await t.call("admin@unit50.com", "GET", "/api/admin/users")).statusCode,
      403,
    );
    assert.equal(
      (
        await t.call(
          "cara@unit50.com",
          "DELETE",
          "/api/admin/users/cara@unit50.com",
        )
      ).statusCode,
      409,
    );
    // Removing someone signs them out of the app on their next request.
    assert.equal(
      (
        await t.call(
          "cara@unit50.com",
          "DELETE",
          "/api/admin/users/ben@unit50.com",
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await t.call("ben@unit50.com", "GET", "/api/summary")).statusCode,
      403,
    );
  } finally {
    // Only if the test got as far as adding her.
    if (people.includes("cara@unit50.com"))
      people.splice(people.indexOf("cara@unit50.com"), 1);
    await t.close();
  }
});

test("follow-ups belong to the rep who scheduled them; visit history is shared", async () => {
  const t = await team();
  try {
    const due = "2026-01-02"; // in the past, so it counts as due
    assert.equal(
      (
        await t.call(
          "ana@unit50.com",
          "POST",
          "/api/properties/001234567/visits",
          { result: "Interested", notes: "Wants a quote" },
        )
      ).statusCode,
      201,
    );
    const anaTask = (
      await t.call("ana@unit50.com", "POST", "/api/follow-ups", {
        propertyId: "001234567",
        dueDate: due,
      })
    ).json().id;
    const benTask = (
      await t.call("ben@unit50.com", "POST", "/api/follow-ups", {
        propertyId: "001234567",
        dueDate: due,
      })
    ).json().id;
    const list = async (as: string, query = "") =>
      (await t.call(as, "GET", `/api/follow-ups${query}`))
        .json()
        .items.map((f: { id: string }) => f.id);
    assert.deepEqual(await list("ana@unit50.com"), [anaTask]);
    assert.deepEqual(await list("ben@unit50.com"), [benTask]);
    assert.deepEqual(
      (await list("admin@unit50.com")).sort(),
      [anaTask, benTask].sort(),
    );
    assert.deepEqual(await list("admin@unit50.com", "?who=me"), []);
    // On the property, Ben sees Ana's visit (with her name) but only his own follow-up.
    const seen = (
      await t.call("ben@unit50.com", "GET", "/api/properties/001234567")
    ).json();
    assert.equal(seen.visits.length, 1);
    assert.equal(seen.visits[0].createdBy, "ana@unit50.com");
    assert.deepEqual(
      seen.followUps.map((f: { id: string }) => f.id),
      [benTask],
    );
    // Ben cannot reschedule or close Ana's follow-up; an admin can.
    assert.equal(
      (
        await t.call("ben@unit50.com", "PATCH", `/api/follow-ups/${anaTask}`, {
          state: "completed",
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await t.call(
          "admin@unit50.com",
          "PATCH",
          `/api/follow-ups/${anaTask}`,
          { notes: "Checked" },
        )
      ).statusCode,
      200,
    );
    // The counters are the rep's own; an admin's are the team's.
    const summary = async (as: string) =>
      (await t.call(as, "GET", "/api/summary")).json();
    assert.equal((await summary("ana@unit50.com")).due, 1);
    assert.equal((await summary("ana@unit50.com")).visited, 1);
    assert.equal((await summary("ben@unit50.com")).visited, 0);
    assert.equal((await summary("admin@unit50.com")).due, 2);
  } finally {
    await t.close();
  }
});

test("website webhook: only correctly signed, recent deliveries are accepted", async () => {
  const body = JSON.stringify({ event: "lead.created", leadId: "L1" });
  const now = Date.now(),
    ts = Math.floor(now / 1000);
  const good = sign(body, ts);
  assert.equal(
    verifyWebhook(
      SECRET,
      good["x-unit50-timestamp"],
      good["x-unit50-signature"],
      body,
      now,
    ),
    true,
  );
  assert.equal(
    verifyWebhook(
      SECRET,
      good["x-unit50-timestamp"],
      good["x-unit50-signature"],
      body + " ",
      now,
    ),
    false,
  );
  assert.equal(
    verifyWebhook(
      "other",
      good["x-unit50-timestamp"],
      good["x-unit50-signature"],
      body,
      now,
    ),
    false,
  );
  assert.equal(
    verifyWebhook(
      SECRET,
      good["x-unit50-timestamp"],
      good["x-unit50-signature"],
      body,
      now + 301_000,
    ),
    false,
  );
  assert.equal(
    verifyWebhook(SECRET, undefined, good["x-unit50-signature"], body, now),
    false,
  );
  assert.equal(
    verifyWebhook(SECRET, good["x-unit50-timestamp"], "zz", body, now),
    false,
  );

  assert.deepEqual(
    parseLeadEvent({ event: "application.created", applicationId: "A1" }),
    {
      ignored: "event application.created is not a lead",
    },
  );
  assert.throws(
    () =>
      parseLeadEvent({
        event: "lead.created",
        leadId: "L1",
        occurredAt: new Date().toISOString(),
        data: { phone: "555" },
      }),
    /phone/,
  );
  const parsed = parseLeadEvent({
    event: "lead.followup_requested",
    leadId: "L1",
    occurredAt: "2026-10-10T15:00:00.000Z",
    data: {
      phone: "+18015550123",
      address: "3147 N 2575 W, Farr West, UT 84404, USA",
      photoUrl: "https://evil.example/x.jpg",
      designUrl:
        "https://res.cloudinary.com/demo/image/authenticated/s--x--/v1/d.png",
      change: "nonsense",
      lat: 999,
    },
  });
  assert.ok("lead" in parsed);
  if ("lead" in parsed) {
    assert.equal(parsed.lead.followUpRequestedAt, "2026-10-10T15:00:00.000Z");
    assert.equal(parsed.lead.photoUrl, null);
    assert.match(parsed.lead.designUrl!, /^https:\/\/res\.cloudinary\.com\//);
    assert.equal(parsed.lead.change, null);
    assert.equal(parsed.lead.lat, null);
    assert.equal(parsed.lead.contactPermission, null);
  }

  const t = await team();
  try {
    const event = (
      data: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) =>
      JSON.stringify({
        event: "lead.created",
        leadId: "lead-1",
        occurredAt: "2026-10-10T14:00:00.000Z",
        data,
        ...extra,
      });
    const first = event({
      phone: "+18015550123",
      address: "3147 N 2575 W, Farr West, UT 84404, USA",
      contactPermission: true,
      change: "siding",
      collectionId: "heritage",
    });
    assert.equal(
      (
        await t.webhook(first, {
          "x-unit50-timestamp": "1",
          "x-unit50-signature": "00",
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await t.webhook("{not json", sign("{not json"))).statusCode,
      400,
    );
    assert.equal((await t.webhook(first)).statusCode, 200);
    // The same delivery again changes nothing.
    assert.equal((await t.webhook(first)).statusCode, 200);
    const [lead] = await t.sql`SELECT * FROM leads`;
    assert.equal(lead.propertyId, "001234567");
    assert.equal(lead.contactPermission, true);
    assert.equal(lead.stage, "new");
    assert.equal(lead.owner, null);
    // A follow-up request fills in the time and the design, and keeps the rest.
    const later = event(
      {
        phone: "+18015550123",
        designUrl: "https://res.cloudinary.com/demo/image/authenticated/d.png",
      },
      {
        event: "lead.followup_requested",
        occurredAt: "2026-10-11T09:00:00.000Z",
      },
    );
    assert.equal((await t.webhook(later)).statusCode, 200);
    const [updated] = await t.sql`SELECT * FROM leads`;
    assert.equal(updated.address, "3147 N 2575 W, Farr West, UT 84404, USA");
    assert.equal(updated.contactPermission, true);
    assert.equal(
      new Date(updated.followUpRequestedAt).toISOString(),
      "2026-10-11T09:00:00.000Z",
    );
    assert.equal(
      updated.designUrl,
      "https://res.cloudinary.com/demo/image/authenticated/d.png",
    );
    assert.equal(
      new Date(updated.createdAt).toISOString(),
      "2026-10-10T14:00:00.000Z",
    );
    // The homeowner changes their number and unticks "OK to contact me"; a
    // retried older delivery arriving afterwards does not undo that.
    const changed = event(
      {
        phone: "+18015550999",
        contactPermission: false,
        addressFormatted: "3147 N 2575 W, Farr West, UT 84404, USA",
        address: "3147 n 2575 w farr west",
      },
      { event: "lead.updated", occurredAt: "2026-10-12T09:00:00.000Z" },
    );
    assert.equal((await t.webhook(changed)).statusCode, 200);
    assert.equal((await t.webhook(first)).statusCode, 200);
    const [current] = await t.sql`SELECT * FROM leads`;
    assert.equal(current.phone, "+18015550999");
    assert.equal(current.contactPermission, false);
    assert.equal(current.address, "3147 N 2575 W, Farr West, UT 84404, USA");
    assert.equal(
      new Date(current.lastEventAt).toISOString(),
      "2026-10-12T09:00:00.000Z",
    );
    const careers = JSON.stringify({
      event: "application.created",
      applicationId: "A1",
      occurredAt: new Date().toISOString(),
      data: {},
    });
    assert.equal((await t.webhook(careers)).statusCode, 202);
    assert.equal((await t.sql`SELECT count(*)::int AS n FROM leads`)[0].n, 1);
  } finally {
    await t.close();
  }
});

test("lead addresses are matched to a parcel only when the match is clear", async () => {
  await withDb(async (sql) => {
    await startImport(sql, "t");
    await runImport(
      sql,
      "t",
      source([
        feature(1, "001234567", {
          PROP_STREET: "3147 N 2575 W",
          PROP_ZIP: "84404",
        }),
        feature(2, "002222222", {
          PROP_STREET: "3151 N 2575 W",
          PROP_ZIP: "84404",
        }),
      ]),
    );
    const [p] = await sql`SELECT lat, lng FROM properties WHERE id='001234567'`;
    const here = { lat: Number(p.lat), lng: Number(p.lng) };
    // Both test parcels share one position, so the house number decides.
    assert.equal(
      await matchProperty(sql, {
        address: "3151 North 2575 West, Farr West, UT 84404, USA",
        ...here,
      }),
      "002222222",
    );
    assert.equal(
      await matchProperty(sql, {
        address: "3147 N 2575 W, Farr West, UT 84404, USA",
        ...here,
      }),
      "001234567",
    );
    // An unknown number at the same spot falls back to the nearest parcel.
    assert.ok(await matchProperty(sql, { address: "9999 N 2575 W", ...here }));
    // Far away with no matching number: no match.
    assert.equal(
      await matchProperty(sql, {
        address: "9999 N 2575 W",
        lat: here.lat + 0.01,
        lng: here.lng,
      }),
      null,
    );
    // Without a position: exact number, street and ZIP, and only one parcel.
    assert.equal(
      await matchProperty(sql, {
        address: "3147 N 2575 W, Farr West, UT 84404",
        lat: null,
        lng: null,
      }),
      "001234567",
    );
    assert.equal(
      await matchProperty(sql, {
        address: "3147 N 2575 W, Ogden, UT 84401",
        lat: null,
        lng: null,
      }),
      null,
    );
    assert.equal(
      await matchProperty(sql, {
        address: "Farr West, UT 84404",
        lat: null,
        lng: null,
      }),
      null,
    );
  });
});

test("lead board: reps take leads from the pool; only admins hand them to others", async () => {
  const t = await team();
  try {
    for (const id of ["a", "b", "c"])
      await t.webhook(
        JSON.stringify({
          event: "lead.created",
          leadId: id,
          occurredAt: new Date().toISOString(),
          data: { phone: "+18015550100", address: "1 Main St" },
        }),
      );
    const board = async (as: string) =>
      (await t.call(as, "GET", "/api/leads")).json() as {
        items: { id: string; owner: string | null; stage: string }[];
        team: string[];
      };
    assert.equal((await board("ana@unit50.com")).items.length, 3);
    assert.deepEqual((await board("ana@unit50.com")).team, []);
    assert.equal((await board("admin@unit50.com")).team.length, 3);
    // Moving a pool lead takes it.
    const moved = await t.call("ana@unit50.com", "PATCH", "/api/leads/a", {
      stage: "contacted",
    });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().owner, "ana@unit50.com");
    assert.equal(moved.json().stage, "contacted");
    // Ben no longer sees it and cannot touch it.
    assert.deepEqual(
      (await board("ben@unit50.com")).items.map((l) => l.id).sort(),
      ["b", "c"],
    );
    assert.equal(
      (
        await t.call("ben@unit50.com", "PATCH", "/api/leads/a", {
          stage: "won",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await t.call("ben@unit50.com", "PATCH", "/api/leads/a", {
          owner: "ben@unit50.com",
        })
      ).statusCode,
      409,
    );
    // A rep can take a lead or hand their own back, but not give it to someone else.
    assert.equal(
      (
        await t.call("ben@unit50.com", "PATCH", "/api/leads/b", {
          owner: "ben@unit50.com",
        })
      ).json().owner,
      "ben@unit50.com",
    );
    assert.equal(
      (
        await t.call("ben@unit50.com", "PATCH", "/api/leads/b", {
          owner: "ana@unit50.com",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await t.call("ben@unit50.com", "PATCH", "/api/leads/b", { owner: null })
      ).json().owner,
      null,
    );
    // An admin assigns to anyone on the team, and sees every lead.
    assert.equal(
      (
        await t.call("admin@unit50.com", "PATCH", "/api/leads/c", {
          owner: "ben@unit50.com",
        })
      ).json().owner,
      "ben@unit50.com",
    );
    assert.equal(
      (
        await t.call("admin@unit50.com", "PATCH", "/api/leads/c", {
          owner: "stranger@x.com",
        })
      ).statusCode,
      400,
    );
    assert.equal((await board("admin@unit50.com")).items.length, 3);
    assert.equal(
      (
        await t.call("ana@unit50.com", "PATCH", "/api/leads/a", {
          stage: "sold",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await t.call("ana@unit50.com", "PATCH", "/api/leads/nope", {
          stage: "won",
        })
      ).statusCode,
      404,
    );
    // Notes are saved; removing a rep puts their leads back in the pool.
    assert.equal(
      (
        await t.call("ana@unit50.com", "PATCH", "/api/leads/a", {
          notes: "  Call after 5  ",
        })
      ).json().notes,
      "Call after 5",
    );
    await t.call(
      "admin@unit50.com",
      "DELETE",
      "/api/admin/users/ana@unit50.com",
    );
    const [a] = await t.sql`SELECT owner, stage FROM leads WHERE id='a'`;
    assert.equal(a.owner, null);
    assert.equal(a.stage, "contacted");
  } finally {
    await t.close();
  }
});

test("webhook is off without a secret", async () => {
  const schema = await createSchema();
  const app = await createApp({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    cloudinary: null,
    auth: null,
    leadsWebhookSecret: null,
  });
  try {
    const body = JSON.stringify({ event: "lead.created" });
    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/website",
      headers: {
        host: "127.0.0.1",
        "content-type": "application/json",
        ...sign(body),
      },
      payload: body,
    });
    assert.equal(response.statusCode, 503);
  } finally {
    await app.close();
    await dropSchema(schema);
  }
});

test("only the super admin reaches county data; nobody can change them from the app", async () => {
  const t = await team();
  people.push("owner@unit50.com");
  try {
    await t.sql`INSERT INTO app_users (email, role, modules, super_admin) VALUES ('owner@unit50.com', 'rep', '{}', true)`;
    const me = (await t.call("owner@unit50.com", "GET", "/api/me")).json();
    assert.deepEqual(me, {
      email: "owner@unit50.com",
      role: "admin",
      modules: ["map", "follow-ups", "leads"],
      superAdmin: true,
    });
    for (const url of [
      "/api/imports",
      "/api/data/issues",
      "/api/county-details",
    ]) {
      assert.equal(
        (await t.call("owner@unit50.com", "GET", url)).statusCode,
        200,
        url,
      );
      // Admins and reps are turned away before any import code runs.
      for (const as of ["admin@unit50.com", "ana@unit50.com"]) {
        const refused = await t.call(as, "GET", url);
        assert.equal(refused.statusCode, 403, `${as} ${url}`);
        assert.match(refused.json().error, /does not have access/);
      }
    }
    for (const [method, url] of [
      ["POST", "/api/imports"],
      ["POST", "/api/county-details/runs"],
      ["POST", "/api/properties/001234567/county"],
    ] as const) {
      const refused = await t.call("admin@unit50.com", method, url, {});
      assert.equal(refused.statusCode, 403, url);
      assert.match(refused.json().error, /does not have access/);
      // The super admin gets past the access check (this test server has imports switched off).
      const owner = await t.call("owner@unit50.com", method, url, {});
      assert.doesNotMatch(
        String(owner.json().error),
        /does not have access/,
        url,
      );
    }
    // The team list shows the super admin, and the app cannot change or remove them.
    const listed = (
      await t.call("admin@unit50.com", "GET", "/api/admin/users")
    ).json().items;
    assert.equal(listed[0].email, "owner@unit50.com");
    assert.equal(listed[0].superAdmin, true);
    for (const [method, payload] of [
      ["PATCH", { role: "rep" }],
      ["PATCH", { modules: ["map"] }],
      ["DELETE", undefined],
    ] as const) {
      const r = await t.call(
        "admin@unit50.com",
        method,
        "/api/admin/users/owner@unit50.com",
        payload,
      );
      assert.equal(r.statusCode, 409);
      assert.match(r.json().error, /managed from the server/);
    }
    // There is no way to make someone super admin through the API.
    assert.equal(
      (
        await t.call(
          "admin@unit50.com",
          "PATCH",
          "/api/admin/users/ana@unit50.com",
          { superAdmin: true },
        )
      ).statusCode,
      400,
    );
    // Modules can no longer include Data & imports.
    assert.equal(
      (
        await t.call(
          "admin@unit50.com",
          "PATCH",
          "/api/admin/users/ana@unit50.com",
          { modules: ["data"] },
        )
      ).statusCode,
      400,
    );
  } finally {
    people.splice(people.indexOf("owner@unit50.com"), 1);
    await t.close();
  }
});
