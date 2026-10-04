import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import Supercluster from "supercluster";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  STATUSES,
  PRIORITIES,
  utahToday,
  priorityFor,
  type Filters,
  type Summary,
  type DetailsCoverage,
} from "../shared/types.js";
import { runImport } from "./importer.js";
import {
  cloudinaryConfig,
  uploadTicket,
  verifyUpload,
  photoPrefix,
  photoUrl,
  destroyPhoto,
  MAX_PHOTOS_PER_PROPERTY,
  type CloudinaryConfig,
  type Fetcher,
} from "./cloudinary.js";
import {
  openDb,
  migrate,
  AppError,
  whereFor,
  prioritySql,
  listProperties,
  detail,
  revision,
  importRun,
  updateProspect,
  addVisit,
  addFollowUp,
  followUps,
  updateFollowUp,
  requireProperty,
} from "./db.js";
import {
  detailsRun,
  refreshCountyDetails,
  runCountyDetails,
} from "./parcelsearch.js";
import {
  authConfig,
  supabaseVerifier,
  cached,
  type AuthConfig,
  type AuthUser,
  type TokenVerifier,
} from "./auth.js";

const str = (maxLength = 200) => ({ type: "string", maxLength });
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const status = { type: "string", enum: [...STATUSES] };
const idParams = object({ id: str(100) }, ["id"]);
const filterSchema = {
  q: str(),
  city: str(),
  priority: { type: "string", enum: ["", ...PRIORITIES] },
  status: { type: "string", enum: ["", ...STATUSES] },
  minAge: { type: "integer", minimum: 0, maximum: 500 },
  maxAge: { type: "integer", minimum: 0, maximum: 500 },
  active: { type: "string", enum: ["all", "active"] },
  bbox: str(150),
};
function validateFilters(f: Filters) {
  if (
    f.minAge !== undefined &&
    f.maxAge !== undefined &&
    Number(f.minAge) > Number(f.maxAge)
  )
    throw new AppError(400, "Minimum age must not exceed maximum age.");
  if (f.bbox) {
    const v = f.bbox.split(",").map(Number);
    if (
      v.length !== 4 ||
      v.some((n) => !Number.isFinite(n)) ||
      v[0] < -180 ||
      v[2] > 180 ||
      v[1] < -90 ||
      v[3] > 90 ||
      v[0] > v[2] ||
      v[1] > v[3]
    )
      throw new AppError(400, "Invalid map bounds.");
  }
}
export async function createApp(
  options: {
    databaseUrl?: string;
    schema?: string;
    staticDir?: string;
    logger?: boolean;
    allowImports?: boolean;
    // null turns property photos off; undefined reads the CLOUDINARY_* variables.
    cloudinary?: CloudinaryConfig | null;
    fetcher?: Fetcher;
    // null turns sign-in off (the server then only answers local requests);
    // undefined reads the SUPABASE_* variables. verify replaces the Supabase check.
    auth?: (AuthConfig & { verify?: TokenVerifier }) | null;
  } = {},
) {
  const sql = openDb(options.databaseUrl, options.schema);
  await migrate(sql);
  const cloudinary =
    options.cloudinary === undefined ? cloudinaryConfig() : options.cloudinary;
  const auth: (AuthConfig & { verify?: TokenVerifier }) | null =
    options.auth === undefined ? authConfig() : options.auth;
  const verify = auth && cached(auth.verify || supabaseVerifier(auth));
  const signedIn = new WeakMap<object, AuthUser>();
  // Any run from a prior process is gone. Never activate its partial staging rows.
  await sql.begin(async (tx) => {
    const now = new Date().toISOString();
    await tx`DELETE FROM staging WHERE run_id IN (SELECT id FROM imports WHERE state='running')`;
    await tx`UPDATE imports SET state='failed', finished_at=${now}, message='Import interrupted by application restart. Previous dataset preserved.' WHERE state='running'`;
    await tx`UPDATE details_runs SET state='stopped', finished_at=${now}, message='Interrupted by application restart. Start again to resume.' WHERE state IN ('running','stopping')`;
  });
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32768,
    ajv: { customOptions: { removeAdditional: false } },
  });
  let importing = false,
    fetchingDetails = false;
  const indices = new Map<string, Supercluster<any, any>>();
  let lastRevision = "";
  const openPaths = new Set(["/api/health", "/api/config"]);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    // The app is never meant to be embedded in another site.
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    const path = req.url.split("?")[0];
    if (path.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    if (!verify) {
      // Without sign-in the server is a single-user tool for this computer only.
      const host = req.headers.host || "";
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
        return reply.code(403).send({ error: "Local access only." });
      const allowedOrigins = new Set(
        [process.env.PORT || "3000", "5173", "3100"].flatMap((port) => [
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
        ]),
      );
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin))
        return reply.code(403).send({ error: "Origin not allowed." });
      return;
    }
    // The page itself is public; every API call needs a signed-in, enabled user.
    if (!path.startsWith("/api/") || openPaths.has(path)) return;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
    const user = token ? await verify(token) : null;
    if (!user) return reply.code(401).send({ error: "Sign in to continue." });
    const [enabled] =
      await sql`SELECT 1 FROM app_users WHERE email=${user.email}`;
    if (!enabled)
      return reply
        .code(403)
        .send({ error: "This account is not enabled for Unit 50." });
    signedIn.set(req, user);
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown };
    const code = e.validation ? 400 : e.statusCode || 500;
    if (code >= 500) app.log.error(error);
    reply.code(code).send({
      error:
        code >= 500
          ? "An unexpected error occurred. Your saved data was not replaced."
          : e.message,
    });
  });
  app.get("/api/health", async () => ({ ok: true }));
  // What the browser needs to show the sign-in screen. Both values are public.
  app.get("/api/config", async () => ({
    auth: auth ? { url: auth.url, key: auth.key } : null,
  }));
  app.get("/api/me", async (req) => ({
    email: signedIn.get(req)?.email ?? null,
  }));
  app.get("/api/summary", async (): Promise<Summary> => {
    const [[row], [visited], [due], cities, latest] = await Promise.all([
      sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE (${prioritySql(sql)})='High')::int AS high, COUNT(*) FILTER (WHERE p.lng IS NOT NULL)::int AS mapped FROM properties p WHERE p.active`,
      sql`SELECT COUNT(DISTINCT property_id)::int AS n FROM visits`,
      sql`SELECT COUNT(*)::int AS n FROM follow_ups WHERE state='pending' AND due_date<=${utahToday()}`,
      sql`SELECT DISTINCT city FROM properties WHERE active AND city!='' ORDER BY city`,
      importRun(sql),
    ]);
    return {
      total: Number(row.total),
      high: Number(row.high),
      mapped: Number(row.mapped),
      visited: Number(visited.n),
      due: Number(due.n),
      cities: cities.map((r) => String(r.city)),
      latest,
      today: utahToday(),
      photosEnabled: Boolean(cloudinary),
    };
  });
  app.get<{ Querystring: Filters & { page?: number; pageSize?: number } }>(
    "/api/properties",
    {
      schema: {
        querystring: object({
          ...filterSchema,
          page: { type: "integer", minimum: 1, maximum: 100000 },
          pageSize: { type: "integer", minimum: 1, maximum: 100 },
        }),
      },
    },
    async (req) => {
      validateFilters(req.query);
      return listProperties(
        sql,
        req.query,
        req.query.page || 1,
        req.query.pageSize || 40,
      );
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/properties/:id",
    { schema: { params: idParams } },
    async (req) => detail(sql, req.params.id),
  );
  app.get<{ Querystring: Filters & { zoom: number } }>(
    "/api/map",
    {
      schema: {
        querystring: object(
          {
            ...filterSchema,
            zoom: { type: "integer", minimum: 0, maximum: 20 },
          },
          ["bbox", "zoom"],
        ),
      },
    },
    async (req) => {
      validateFilters(req.query);
      const { bbox, zoom, ...f } = req.query;
      const rev = (await revision(sql)) + utahToday().slice(0, 4);
      if (rev !== lastRevision) {
        indices.clear();
        lastRevision = rev;
      }
      const key = JSON.stringify(
        Object.entries(f).sort(([a], [b]) => a.localeCompare(b)),
      );
      let index = indices.get(key);
      if (!index) {
        const currentYear = Number(utahToday().slice(0, 4));
        const rows =
          await sql`SELECT p.id, p.address, p.lng, p.lat, p.year, p.conflict, COALESCE(s.status,'Not visited') AS status FROM properties p LEFT JOIN prospects s ON s.property_id=p.id WHERE ${whereFor(sql, f)} AND p.lng IS NOT NULL`;
        index = new Supercluster({ radius: 55, maxZoom: 17 });
        index.load(
          rows.map((r) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [Number(r.lng), Number(r.lat)],
            },
            properties: {
              id: r.id,
              address: r.address,
              status: r.status,
              priority: priorityFor(
                r.year as number | null,
                Boolean(r.conflict),
                currentYear,
              ).priority,
            },
          })),
        );
        if (indices.size >= 5) indices.delete(indices.keys().next().value!);
        indices.set(key, index);
      }
      const features = index
        .getClusters(
          bbox!.split(",").map(Number) as [number, number, number, number],
          zoom,
        )
        .map((f) =>
          f.properties.cluster
            ? {
                ...f,
                properties: {
                  ...f.properties,
                  expansionZoom: index!.getClusterExpansionZoom(
                    f.properties.cluster_id,
                  ),
                },
              }
            : f,
        );
      return { type: "FeatureCollection", features };
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { status: (typeof STATUSES)[number] };
  }>(
    "/api/properties/:id/prospect",
    { schema: { params: idParams, body: object({ status }, ["status"]) } },
    async (req) => {
      await updateProspect(sql, req.params.id, req.body.status);
      return detail(sql, req.params.id);
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      result: (typeof STATUSES)[number];
      notes?: string;
      occurredAt?: string;
    };
  }>(
    "/api/properties/:id/visits",
    {
      schema: {
        params: idParams,
        body: object(
          {
            result: status,
            notes: str(5000),
            occurredAt: { type: "string", format: "date-time" },
          },
          ["result"],
        ),
      },
    },
    async (req, reply) => {
      if (
        req.body.occurredAt &&
        Date.parse(req.body.occurredAt) > Date.now() + 60000
      )
        throw new AppError(400, "A visit cannot be in the future.");
      const when = req.body.occurredAt
        ? new Date(req.body.occurredAt).toISOString()
        : undefined;
      const id = await addVisit(
        sql,
        req.params.id,
        req.body.result,
        req.body.notes || "",
        when,
      );
      return reply.code(201).send({ id });
    },
  );
  app.get("/api/follow-ups", async () => ({
    items: await followUps(sql),
    today: utahToday(),
  }));
  app.post<{ Body: { propertyId: string; dueDate: string; notes?: string } }>(
    "/api/follow-ups",
    {
      schema: {
        body: object(
          { propertyId: str(100), dueDate: str(10), notes: str(2000) },
          ["propertyId", "dueDate"],
        ),
      },
    },
    async (req, reply) =>
      reply.code(201).send({
        id: await addFollowUp(
          sql,
          req.body.propertyId,
          req.body.dueDate,
          req.body.notes || "",
        ),
      }),
  );
  app.patch<{
    Params: { id: string };
    Body: {
      dueDate?: string;
      state?: "pending" | "completed" | "cancelled";
      notes?: string;
    };
  }>(
    "/api/follow-ups/:id",
    {
      schema: {
        params: idParams,
        body: {
          ...object({
            dueDate: str(10),
            state: {
              type: "string",
              enum: ["pending", "completed", "cancelled"],
            },
            notes: str(2000),
          }),
          minProperties: 1,
        },
      },
    },
    async (req) => {
      await updateFollowUp(sql, req.params.id, req.body);
      return { ok: true };
    },
  );
  app.get("/api/imports", async () => ({
    items: await sql`SELECT * FROM imports ORDER BY started_at DESC LIMIT 15`,
  }));
  app.get<{ Params: { id: string } }>(
    "/api/imports/:id",
    { schema: { params: idParams } },
    async (req) => {
      const run = await importRun(sql, req.params.id);
      if (!run) throw new AppError(404, "Import not found.");
      return run;
    },
  );
  app.get("/api/data/issues", async () => ({
    items:
      await sql`SELECT id, address, issues FROM properties WHERE active AND issues!='[]'::jsonb ORDER BY conflict DESC, id LIMIT 100`,
  }));
  app.post("/api/imports", async (_req, reply) => {
    if (options.allowImports === false)
      throw new AppError(403, "Imports are disabled in this test instance.");
    if (
      importing ||
      (await sql`SELECT 1 FROM imports WHERE state='running'`).length
    )
      throw new AppError(409, "An import is already running.");
    const id = randomUUID();
    await sql`INSERT INTO imports (id, state, started_at) VALUES (${id}, 'running', ${new Date().toISOString()})`;
    importing = true;
    // Runs in the background; progress is read from the imports table.
    void runImport(sql, id)
      .catch(
        (e) =>
          sql`UPDATE imports SET state='failed', finished_at=${new Date().toISOString()}, message=${String(e?.message || e)} WHERE id=${id} AND state='running'`,
      )
      .catch((e) => app.log.error(e))
      .finally(() => {
        importing = false;
        indices.clear();
      });
    return reply.code(202).send({ id });
  });
  app.post<{ Params: { id: string } }>(
    "/api/properties/:id/county",
    { schema: { params: idParams } },
    async (req) => {
      if (options.allowImports === false)
        throw new AppError(
          403,
          "County lookups are disabled in this test instance.",
        );
      await requireProperty(sql, req.params.id);
      if (!(await refreshCountyDetails(sql, req.params.id))) {
        const [row] =
          await sql`SELECT error FROM county_details WHERE property_id=${req.params.id}`;
        throw new AppError(502, String(row?.error));
      }
      return detail(sql, req.params.id);
    },
  );
  app.get("/api/county-details", async (): Promise<DetailsCoverage> => {
    const [row] =
      await sql`SELECT COUNT(*)::int AS active, COUNT(*) FILTER (WHERE d.data IS NOT NULL)::int AS fetched, COUNT(*) FILTER (WHERE d.state='error')::int AS errors FROM properties p LEFT JOIN county_details d ON d.property_id=p.id WHERE p.active`;
    return {
      active: Number(row.active),
      fetched: Number(row.fetched),
      errors: Number(row.errors),
      latest: await detailsRun(sql),
    };
  });
  app.post<{ Body: { mode?: "missing" | "refresh" } }>(
    "/api/county-details/runs",
    {
      schema: {
        body: object({
          mode: { type: "string", enum: ["missing", "refresh"] },
        }),
      },
    },
    async (req, reply) => {
      if (options.allowImports === false)
        throw new AppError(
          403,
          "County lookups are disabled in this test instance.",
        );
      if (
        fetchingDetails ||
        (
          await sql`SELECT 1 FROM details_runs WHERE state IN ('running','stopping')`
        ).length
      )
        throw new AppError(
          409,
          "Parcel Search details are already being fetched.",
        );
      const id = randomUUID(),
        mode = req.body.mode || "missing";
      await sql`INSERT INTO details_runs (id, state, mode, started_at) VALUES (${id}, 'running', ${mode}, ${new Date().toISOString()})`;
      fetchingDetails = true;
      void runCountyDetails(sql, id, { mode })
        .catch((e) => app.log.error(e))
        .finally(() => {
          fetchingDetails = false;
        });
      return reply.code(202).send({ id });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/county-details/runs/:id/stop",
    { schema: { params: idParams } },
    async (req) => {
      await sql`UPDATE details_runs SET state='stopping', message='Stopping after the current parcels…' WHERE id=${req.params.id} AND state='running'`;
      return detailsRun(sql, req.params.id);
    },
  );
  // Property photos. The browser asks for an upload ticket, sends the file
  // straight to Cloudinary, then reports the result here to attach it.
  function requirePhotos() {
    if (!cloudinary)
      throw new AppError(
        503,
        "Photos are not set up. Add the CLOUDINARY_* variables to .env.",
      );
    return cloudinary;
  }
  app.post<{ Params: { id: string } }>(
    "/api/properties/:id/photos/ticket",
    { schema: { params: idParams } },
    async (req) => {
      const config = requirePhotos();
      await requireProperty(sql, req.params.id);
      const [{ n }] =
        await sql`SELECT COUNT(*)::int AS n FROM property_photos WHERE property_id=${req.params.id}`;
      if (Number(n) >= MAX_PHOTOS_PER_PROPERTY)
        throw new AppError(
          409,
          `A property can have up to ${MAX_PHOTOS_PER_PROPERTY} photos. Remove one to add another.`,
        );
      return uploadTicket(config, req.params.id);
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      publicId: string;
      version: number;
      signature: string;
      format: string;
      width?: number;
      height?: number;
      bytes?: number;
    };
  }>(
    "/api/properties/:id/photos",
    {
      schema: {
        params: idParams,
        body: object(
          {
            publicId: str(300),
            version: { type: "integer", minimum: 1 },
            signature: str(200),
            format: { type: "string", pattern: "^[a-z0-9]{2,5}$" },
            width: { type: "integer", minimum: 1 },
            height: { type: "integer", minimum: 1 },
            bytes: { type: "integer", minimum: 1 },
          },
          ["publicId", "version", "signature", "format"],
        ),
      },
    },
    async (req, reply) => {
      const config = requirePhotos(),
        b = req.body;
      await requireProperty(sql, req.params.id);
      if (
        !b.publicId.startsWith(photoPrefix(req.params.id)) ||
        !verifyUpload(config, b)
      )
        throw new AppError(
          400,
          "This upload could not be verified. Try adding the photo again.",
        );
      const id = randomUUID();
      const [saved] =
        await sql`INSERT INTO property_photos (id, property_id, public_id, url, width, height, bytes, format, created_at) VALUES (${id}, ${req.params.id}, ${b.publicId}, ${photoUrl(config, b.publicId, b.version, b.format)}, ${b.width ?? null}, ${b.height ?? null}, ${b.bytes ?? null}, ${b.format}, ${new Date().toISOString()}) ON CONFLICT (public_id) DO NOTHING RETURNING id`;
      if (!saved) throw new AppError(409, "This photo was already added.");
      return reply.code(201).send({ id });
    },
  );
  app.delete<{ Params: { id: string; photoId: string } }>(
    "/api/properties/:id/photos/:photoId",
    {
      schema: {
        params: object({ id: str(100), photoId: str(100) }, ["id", "photoId"]),
      },
    },
    async (req) => {
      const config = requirePhotos();
      const [photo] =
        await sql`SELECT public_id FROM property_photos WHERE id=${req.params.photoId} AND property_id=${req.params.id}`;
      if (!photo) throw new AppError(404, "Photo not found.");
      // Remove the image first, so a failure never leaves it orphaned in Cloudinary.
      try {
        await destroyPhoto(config, String(photo.publicId), options.fetcher);
      } catch (e) {
        app.log.error(e);
        throw new AppError(
          502,
          "The photo could not be removed from storage. Try again.",
        );
      }
      await sql`DELETE FROM property_photos WHERE id=${req.params.photoId}`;
      return { ok: true };
    },
  );
  const staticDir = options.staticDir || resolve("dist");
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Endpoint not found." })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    await sql.end({ timeout: 5 });
  });
  return app;
}
