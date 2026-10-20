import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApp } from "../server/app.js";
import { signRequest, websiteCareers } from "../server/website.js";
import type { TokenVerifier } from "../server/auth.js";
import { openDb } from "../server/db.js";
import { TEST_DATABASE_URL, createSchema, dropSchema } from "./helpers.js";

const SECRET = "shared-secret";
const careers = {
  open: false,
  jobTitle: "Door-to-door sales representative",
  title: "Sell siding door to door.",
  lede: "Unit 50 is hiring in Weber County, Utah.",
  work: ["Talk with homeowners."],
  fit: ["You like people."],
  note: "",
};
// A stand-in for the website's /api/admin/careers that checks the signature
// the way the website does.
function website(reply?: (method: string, body: string) => Response) {
  const calls: { url: string; method: string; body: string; ok: boolean }[] =
    [];
  let stored = { ...careers, updatedAt: null as number | null };
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const headers = init!.headers as Record<string, string>,
      method = init!.method || "GET",
      body = String(init!.body ?? ""),
      path = new URL(String(url)).pathname,
      ts = headers["X-Unit50-Timestamp"];
    const ok =
      headers["X-Unit50-Signature"] ===
      createHmac("sha256", SECRET)
        .update(`${ts}.${method}.${path}.${body}`)
        .digest("hex");
    calls.push({ url: String(url), method, body, ok });
    if (reply) return reply(method, body);
    if (!ok)
      return new Response(JSON.stringify({ message: "no" }), { status: 401 });
    if (method === "PUT") stored = { ...JSON.parse(body), updatedAt: 1 };
    return new Response(JSON.stringify({ ok: true, careers: stored }));
  }) as typeof fetch;
  return { calls, fetcher };
}

test("requests to the website are signed over the method, path and body", async () => {
  const h = signRequest(
    SECRET,
    "PUT",
    "/api/admin/careers",
    "{}",
    1_800_000_000_000,
  );
  assert.equal(h["X-Unit50-Timestamp"], "1800000000");
  assert.equal(
    h["X-Unit50-Signature"],
    createHmac("sha256", SECRET)
      .update("1800000000.PUT./api/admin/careers.{}")
      .digest("hex"),
  );
  const site = website();
  const options = {
    website: "https://site.example",
    secret: SECRET,
    fetcher: site.fetcher,
  };
  assert.equal((await websiteCareers(options)).open, false);
  const saved = await websiteCareers(options, { ...careers, open: true });
  assert.equal(saved.open, true);
  assert.deepEqual(
    site.calls.map((c) => [c.url, c.method, c.ok]),
    [
      ["https://site.example/api/admin/careers", "GET", true],
      ["https://site.example/api/admin/careers", "PUT", true],
    ],
  );
  assert.deepEqual(JSON.parse(site.calls[1].body), { ...careers, open: true });
});

test("website problems come back as clear messages", async () => {
  await assert.rejects(
    websiteCareers({ website: "https://site.example", secret: null }),
    /not connected/,
  );
  const answer = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status });
  for (const [status, body, message] of [
    [
      400,
      { message: "work: Too small" },
      /refused the change: work: Too small/,
    ],
    [401, {}, /refused this app's signature/],
    [500, {}, /HTTP 500/],
  ] as const) {
    const site = website(answer(status, body));
    await assert.rejects(
      websiteCareers({
        website: "https://site.example",
        secret: SECRET,
        fetcher: site.fetcher,
      }),
      message,
    );
  }
  const down = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;
  await assert.rejects(
    websiteCareers({
      website: "https://site.example",
      secret: SECRET,
      fetcher: down,
    }),
    /did not answer/,
  );
});

test("only admins reach the website settings, and bad input is refused here first", async () => {
  const schema = await createSchema();
  const people: Record<string, { id: string; email: string }> = {
    admin: { id: "1", email: "admin@unit50.com" },
    rep: { id: "2", email: "rep@unit50.com" },
  };
  const verify: TokenVerifier = async (t) => people[t] ?? null;
  const site = website();
  process.env.WEBSITE_URL = "https://site.example/";
  const app = await createApp({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    cloudinary: null,
    fetcher: site.fetcher,
    auth: { url: "https://auth.example", key: "pk", verify },
    leadsWebhookSecret: SECRET,
  });
  delete process.env.WEBSITE_URL;
  try {
    const sql = openDb(TEST_DATABASE_URL, schema);
    await sql`INSERT INTO app_users (email, role) VALUES ('admin@unit50.com', 'admin'), ('rep@unit50.com', 'rep')`;
    await sql.end();
    const call = (as: string, method: "GET" | "PUT", payload?: object) =>
      app.inject({
        method,
        url: "/api/admin/website/careers",
        headers: { host: "unit50.onrender.com", authorization: `Bearer ${as}` },
        ...(payload ? { payload } : {}),
      });
    assert.equal((await call("rep", "GET")).statusCode, 403);
    const read = await call("admin", "GET");
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().website, "https://site.example");
    assert.equal(
      (await call("admin", "PUT", { ...careers, work: [] })).statusCode,
      400,
    );
    assert.equal(
      (await call("admin", "PUT", { ...careers, extra: 1 })).statusCode,
      400,
    );
    const saved = await call("admin", "PUT", { ...careers, open: true });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().careers.open, true);
    // Two calls reached the website: the read and the valid save.
    assert.equal(site.calls.length, 2);
    assert.ok(
      site.calls.every(
        (c) => c.ok && c.url === "https://site.example/api/admin/careers",
      ),
    );
  } finally {
    await app.close();
    await dropSchema(schema);
  }
});

test("a missing website connection is explained, not hidden behind a generic error", async () => {
  const schema = await createSchema();
  const app = await createApp({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    cloudinary: null,
    auth: null,
    leadsWebhookSecret: null,
  });
  try {
    const r = await app.inject({
      method: "GET",
      url: "/api/admin/website/careers",
      headers: { host: "127.0.0.1" },
    });
    assert.equal(r.statusCode, 503);
    assert.match(r.json().error, /not connected yet/);
  } finally {
    await app.close();
    await dropSchema(schema);
  }
});
