import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { createApp } from "../server/app.js";
import {
  authConfig,
  supabaseVerifier,
  cached,
  type TokenVerifier,
} from "../server/auth.js";
import { TEST_DATABASE_URL, createSchema, dropSchema } from "./helpers.js";

test("sign-in settings come from SUPABASE_* or the VITE_ names", () => {
  assert.equal(authConfig({}), null);
  assert.equal(authConfig({ SUPABASE_URL: "https://a.example" }), null);
  assert.deepEqual(
    authConfig({
      VITE_SUPABASE_URL: "https://a.example/",
      VITE_SUPABASE_PUBLISHABLE_KEY: "pk",
    }),
    { url: "https://a.example", key: "pk" },
  );
  assert.deepEqual(
    authConfig({
      SUPABASE_URL: "https://b.example",
      SUPABASE_PUBLISHABLE_KEY: "pk2",
      VITE_SUPABASE_URL: "https://a.example",
      VITE_SUPABASE_PUBLISHABLE_KEY: "pk",
    }),
    { url: "https://b.example", key: "pk2" },
  );
});
test("Supabase check accepts only confirmed accounts and reports outages", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init!.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const verify = supabaseVerifier(
    { url: "https://a.example", key: "pk" },
    fetcher,
  );
  reply = {
    status: 200,
    body: {
      id: "u1",
      email: "Rep@Unit50.com",
      email_confirmed_at: "2026-10-04T00:00:00Z",
    },
  };
  assert.deepEqual(await verify("t1"), { id: "u1", email: "rep@unit50.com" });
  assert.equal(calls[0].url, "https://a.example/auth/v1/user");
  assert.equal(calls[0].headers.apikey, "pk");
  assert.equal(calls[0].headers.Authorization, "Bearer t1");
  reply = { status: 200, body: { id: "u2", email: "new@x.com" } };
  assert.equal(await verify("t2"), null);
  reply = { status: 403, body: { error_code: "bad_jwt" } };
  assert.equal(await verify("t3"), null);
  reply = { status: 500, body: {} };
  await assert.rejects(verify("t4"), /unavailable/);

  let lookups = 0;
  const once = cached(async (token) => {
    lookups++;
    return token === "ok" ? { id: "u1", email: "rep@unit50.com" } : null;
  });
  assert.equal((await once.verify("ok"))?.email, "rep@unit50.com");
  assert.equal((await once.verify("ok"))?.email, "rep@unit50.com");
  assert.equal(await once.verify("bad"), null);
  assert.equal(await once.verify("bad"), null);
  assert.equal(lookups, 2);
  once.forget("ok");
  assert.equal((await once.verify("ok"))?.email, "rep@unit50.com");
  assert.equal(lookups, 3);
});
test("API needs a signed-in user who is enabled in app_users", async () => {
  const schema = await createSchema();
  const people: Record<string, { id: string; email: string }> = {
    "rep-token": { id: "u1", email: "rep@unit50.com" },
    "stranger-token": { id: "u2", email: "stranger@example.com" },
  };
  // Supabase stops recognising a token once its session is signed out.
  const signedOut = new Set<string>();
  const verify: TokenVerifier = async (token) =>
    signedOut.has(token) ? null : (people[token] ?? null);
  const app = await createApp({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    allowImports: false,
    cloudinary: null,
    auth: { url: "https://auth.example", key: "pk", verify },
  });
  try {
    const sql = openDb(TEST_DATABASE_URL, schema);
    await sql`INSERT INTO app_users (email) VALUES ('rep@unit50.com')`;
    await assert.rejects(
      sql`INSERT INTO app_users (email) VALUES ('Mixed@Case.com')`,
    );
    await sql.end();
    // With sign-in on, the server answers on any host name; the token is the gate.
    const get = (url: string, token?: string, method: "GET" | "POST" = "GET") =>
      app.inject({
        method,
        url,
        headers: {
          host: "unit50.onrender.com",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
    assert.equal((await get("/api/health")).statusCode, 200);
    assert.deepEqual((await get("/api/config")).json(), {
      auth: { url: "https://auth.example", key: "pk" },
    });
    for (const url of [
      "/api/summary",
      "/api/properties",
      "/api/me",
      "/api/follow-ups",
      "/api/properties/001234567",
    ]) {
      assert.equal((await get(url)).statusCode, 401, url);
      assert.equal((await get(url, "made-up")).statusCode, 401, url);
      assert.equal((await get(url, "stranger-token")).statusCode, 403, url);
    }
    assert.equal(
      (await get("/api/imports", undefined, "POST")).statusCode,
      401,
    );
    assert.equal(
      (await get("/api/properties/1/photos/ticket", "stranger-token", "POST"))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/summary",
          headers: { authorization: "Basic rep-token" },
        })
      ).statusCode,
      401,
    );
    assert.equal((await get("/api/summary", "rep-token")).statusCode, 200);
    // A new person is a rep with every module until an admin changes that.
    assert.deepEqual((await get("/api/me", "rep-token")).json(), {
      email: "rep@unit50.com",
      role: "rep",
      modules: ["map", "follow-ups", "leads"],
      superAdmin: false,
    });
    assert.equal(
      (await get("/api/summary?x=/api/health", "made-up")).statusCode,
      401,
    );

    // Signing out: the server forgets the token at once, so it is refused on the
    // very next request and not when the remembered answer would have expired.
    people["phone-token"] = people["rep-token"];
    assert.equal((await get("/api/summary", "phone-token")).statusCode, 200);
    assert.equal(
      (await get("/api/logout", "rep-token", "POST")).statusCode,
      200,
    );
    signedOut.add("rep-token");
    assert.equal((await get("/api/summary", "rep-token")).statusCode, 401);
    assert.equal((await get("/api/me", "rep-token")).statusCode, 401);
    // The same person's other device keeps working.
    assert.equal((await get("/api/summary", "phone-token")).statusCode, 200);
    assert.equal((await get("/api/logout", undefined, "POST")).statusCode, 401);

    // Removing the row locks the person out on their next request.
    const admin = openDb(TEST_DATABASE_URL, schema);
    await admin`DELETE FROM app_users WHERE email='rep@unit50.com'`;
    await admin.end();
    assert.equal((await get("/api/summary", "phone-token")).statusCode, 403);
  } finally {
    await app.close();
    await dropSchema(schema);
  }
});
