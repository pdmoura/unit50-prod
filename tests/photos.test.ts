import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { runImport } from "../server/importer.js";
import { createApp } from "../server/app.js";
import {
  sign,
  cloudinaryConfig,
  type CloudinaryConfig,
} from "../server/cloudinary.js";
import { feature, source } from "./fixtures.js";
import {
  TEST_DATABASE_URL,
  createSchema,
  dropSchema,
  startImport,
} from "./helpers.js";

const config: CloudinaryConfig = {
  cloudName: "demo",
  apiKey: "1234567890",
  apiSecret: "test-secret",
  folder: "unit50-uploads",
  algorithm: "sha1",
};
// What Cloudinary sends back after an upload, signed the way Cloudinary signs it.
const uploaded = (publicId: string, version = 1791000000) => ({
  publicId,
  version,
  signature: sign(config, { public_id: publicId, version: String(version) }),
  format: "jpg",
  width: 1200,
  height: 900,
  bytes: 345678,
});

test("Cloudinary is off unless every credential is present", () => {
  assert.equal(cloudinaryConfig({}), null);
  assert.equal(
    cloudinaryConfig({ CLOUDINARY_CLOUD_NAME: "a", CLOUDINARY_API_KEY: "b" }),
    null,
  );
  assert.deepEqual(
    cloudinaryConfig({
      CLOUDINARY_CLOUD_NAME: "a",
      CLOUDINARY_API_KEY: "b",
      CLOUDINARY_API_SECRET: "c",
    }),
    {
      cloudName: "a",
      apiKey: "b",
      apiSecret: "c",
      folder: "unit50-uploads",
      algorithm: "sha1",
    },
  );
});
test("photos: signed ticket, verified attach, listing and removal from Cloudinary", async () => {
  const schema = await createSchema();
  const destroyed: Record<string, string>[] = [];
  let destroyReply: { status: number; body: unknown } = {
    status: 200,
    body: { result: "ok" },
  };
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(
      String(url),
      "https://api.cloudinary.com/v1_1/demo/image/destroy",
    );
    destroyed.push(Object.fromEntries(init!.body as URLSearchParams));
    return new Response(JSON.stringify(destroyReply.body), {
      status: destroyReply.status,
    });
  }) as typeof fetch;
  const app = await createApp({
    databaseUrl: TEST_DATABASE_URL,
    schema,
    allowImports: false,
    cloudinary: config,
    fetcher,
  });
  try {
    const sql = openDb(TEST_DATABASE_URL, schema);
    await startImport(sql, "seed");
    await runImport(sql, "seed", source([feature(), feature(2, "000000002")]));
    await sql.end();
    const base = "/api/properties/001234567/photos";
    assert.equal((await app.inject("/api/summary")).json().photosEnabled, true);

    // The ticket is signed for this property's folder and file name only.
    const ticket = (
      await app.inject({ method: "POST", url: `${base}/ticket` })
    ).json();
    assert.equal(
      ticket.uploadUrl,
      "https://api.cloudinary.com/v1_1/demo/image/upload",
    );
    const { signature, api_key, ...signedFields } = ticket.fields;
    assert.equal(api_key, config.apiKey);
    assert.equal(signedFields.asset_folder, "unit50-uploads");
    assert.match(signedFields.public_id, /^property-001234567-[0-9a-f-]{36}$/);
    assert.equal(signature, sign(config, signedFields));
    assert.ok(!JSON.stringify(ticket).includes(config.apiSecret));
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/properties/nope/photos/ticket",
        })
      ).statusCode,
      404,
    );

    // Only uploads Cloudinary signed, and only for this property, are attached.
    const attach = (payload: unknown, url = base) =>
      app.inject({ method: "POST", url, payload: payload as object });
    const good = uploaded(signedFields.public_id);
    assert.equal(
      (await attach({ ...good, signature: "0".repeat(40) })).statusCode,
      400,
    );
    assert.equal(
      (await attach({ ...good, version: good.version + 1 })).statusCode,
      400,
    );
    assert.equal(
      (await attach(good, "/api/properties/000000002/photos")).statusCode,
      400,
    );
    assert.equal((await attach({ ...good, format: "../x" })).statusCode, 400);
    const created = await attach(good);
    assert.equal(created.statusCode, 201);
    assert.equal((await attach(good)).statusCode, 409);

    const listed = (await app.inject("/api/properties/001234567")).json()
      .photos;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.json().id);
    assert.equal(
      listed[0].url,
      `https://res.cloudinary.com/demo/image/upload/v${good.version}/${good.publicId}.jpg`,
    );
    assert.equal(
      (await app.inject("/api/properties/000000002")).json().photos.length,
      0,
    );

    // A storage failure keeps the photo; nothing is orphaned in Cloudinary.
    const remove = (photoId: string, property = "001234567") =>
      app.inject({
        method: "DELETE",
        url: `/api/properties/${property}/photos/${photoId}`,
      });
    assert.equal(
      (await remove(created.json().id, "000000002")).statusCode,
      404,
    );
    destroyReply = { status: 500, body: { error: { message: "down" } } };
    assert.equal((await remove(created.json().id)).statusCode, 502);
    assert.equal(
      (await app.inject("/api/properties/001234567")).json().photos.length,
      1,
    );

    destroyReply = { status: 200, body: { result: "ok" } };
    destroyed.length = 0;
    assert.equal((await remove(created.json().id)).statusCode, 200);
    const {
      signature: destroySignature,
      api_key: destroyKey,
      ...destroyFields
    } = destroyed[0];
    assert.equal(destroyFields.public_id, good.publicId);
    assert.equal(destroyKey, config.apiKey);
    assert.equal(destroySignature, sign(config, destroyFields));
    assert.equal(
      (await app.inject("/api/properties/001234567")).json().photos.length,
      0,
    );

    // Already gone from Cloudinary still clears the record.
    const again = uploaded(`property-001234567-${"b".repeat(36)}`);
    const second = await attach(again);
    destroyReply = { status: 200, body: { result: "not found" } };
    assert.equal((await remove(second.json().id)).statusCode, 200);
    assert.equal(
      (await app.inject("/api/properties/001234567")).json().photos.length,
      0,
    );
  } finally {
    await app.close();
    await dropSchema(schema);
  }
});
