// One-time job: asks Google, for every property, whether Street View imagery
// exists in front of it, and records the answer (see server/streetviewcheck.ts).
// It stores 'available' plus the panorama ID, or 'none'. It never downloads a
// picture: Google's terms forbid saving or rehosting Street View images.
//
//   npx tsx scripts/street-view-check.ts --id 190880007    one property
//   npx tsx scripts/street-view-check.ts --limit 20        a 20-property pilot
//   npx tsx scripts/street-view-check.ts --all             every unchecked property
//
// Add --dev for the local database (DATABASE_URL_DEV); without it the job
// works on production (DATABASE_URL). Run the same command again to resume:
// properties that already have an answer are skipped.
//
//   --concurrency 4     requests in flight at once (1-16)
//   --dry-run           check and report, but write nothing to the database
//   --retry-uncertain   look again at properties earlier reported as uncertain
//
// Needs GOOGLE_MAPS_API_KEY in .env (and optionally GOOGLE_MAPS_SIGNING_SECRET).
// Progress and problems go to the street-view-report/ folder, not the database.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  openDb,
  migrate,
  databaseUrl,
  describeDatabase,
  devMode,
} from "../server/db.js";
import {
  checkProperty,
  StreetViewDenied,
  type CheckResult,
  type CheckTarget,
} from "../server/streetviewcheck.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
const id = value("--id"),
  limitText = value("--limit"),
  all = flag("--all"),
  dryRun = flag("--dry-run"),
  retryUncertain = flag("--retry-uncertain"),
  concurrency = Number(value("--concurrency") ?? 4),
  limit = limitText === undefined ? null : Number(limitText);
// The full run has to be asked for by name, so it never starts by accident.
if ([id !== undefined, limit !== null, all].filter(Boolean).length !== 1)
  fail(
    "Choose one: --id <property id>, --limit <how many>, or --all. Add --dev for the local database.",
  );
if (id !== undefined && !/^[\w.-]{1,40}$/.test(id))
  fail("--id must be a property (parcel) ID.");
if (limit !== null && (!Number.isInteger(limit) || limit < 1))
  fail("--limit must be a whole number, 1 or more.");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
  fail("--concurrency must be between 1 and 16.");
const key = process.env.GOOGLE_MAPS_API_KEY;
if (!key)
  fail("Set GOOGLE_MAPS_API_KEY in .env first (see .env.example and README).");
const options = {
  key,
  secret: process.env.GOOGLE_MAPS_SIGNING_SECRET || undefined,
  // For rehearsals against a stand-in server; not needed in normal use.
  baseUrl: process.env.STREET_VIEW_METADATA_URL || undefined,
};

const dev = devMode(),
  url = databaseUrl(dev),
  sql = openDb(url),
  // A dry run keeps its own files, so a rehearsal never changes what the
  // real run will skip or report.
  name = (dev ? "dev" : "production") + (dryRun ? "-dry-run" : ""),
  folder = "street-view-report",
  checkpointFile = `${folder}/checkpoint-${name}.jsonl`,
  reportFile = `${folder}/report-${name}.json`,
  reviewFile = `${folder}/review-${name}.csv`;
mkdirSync(folder, { recursive: true });
if (dryRun) writeFileSync(checkpointFile, "");

interface Line {
  id: string;
  address: string;
  outcome: CheckResult["outcome"];
  detail: string;
  at: string;
}
// The checkpoint is one line per checked property, appended as work completes.
// The last line for a property is the one that counts.
const earlier = new Map<string, Line>();
if (existsSync(checkpointFile))
  for (const text of readFileSync(checkpointFile, "utf8").split("\n")) {
    if (!text.trim()) continue;
    try {
      const line = JSON.parse(text) as Line;
      earlier.set(line.id, line);
    } catch {
      // A line cut short by an interruption is ignored.
    }
  }

const counts = {
  processed: 0,
  available: 0,
  none: 0,
  uncertain: 0,
  failed: 0,
  alreadyChecked: 0,
  skippedUncertain: 0,
};
const startedAt = new Date().toISOString(),
  format = new Intl.NumberFormat("en-US");
let stopped = "";
// Ctrl+C finishes the requests in flight, saves them and writes the report.
process.on("SIGINT", () => {
  if (!stopped) console.log("\nStopping after the requests in flight…");
  stopped ||= "interrupted";
});

async function save(rows: { id: string; result: CheckResult }[]) {
  const answers = rows.flatMap(({ id, result }) =>
    result.outcome === "available"
      ? [[id, "available", result.pano]]
      : result.outcome === "none"
        ? [[id, "none", ""]]
        : [],
  );
  if (!answers.length || dryRun) return;
  await sql`UPDATE properties p SET street_view_status=v.status::text, street_view_pano=NULLIF(v.pano::text, '') FROM (VALUES ${sql(answers)}) AS v (id, status, pano) WHERE p.id=v.id::text`;
}
function writeReport() {
  const review = [...earlier.values()].filter(
    (l) => l.outcome === "uncertain" || l.outcome === "failed",
  );
  const cell = (text: string) => `"${text.replaceAll('"', '""')}"`;
  writeFileSync(
    reviewFile,
    ["id,address,outcome,detail,checked_at"]
      .concat(
        review.map((l) =>
          [l.id, l.address, l.outcome, l.detail, l.at].map(cell).join(","),
        ),
      )
      .join("\n") + "\n",
  );
  writeFileSync(
    reportFile,
    JSON.stringify(
      {
        database: describeDatabase(url),
        dryRun,
        startedAt,
        finishedAt: new Date().toISOString(),
        stoppedEarly: stopped || null,
        thisRun: counts,
        forReview: {
          uncertain: review.filter((l) => l.outcome === "uncertain").length,
          failed: review.filter((l) => l.outcome === "failed").length,
          file: reviewFile,
        },
      },
      null,
      2,
    ) + "\n",
  );
}

try {
  await migrate(sql);
  console.log(
    `Database: ${describeDatabase(url)}${dryRun ? " (dry run: nothing will be written)" : ""}`,
  );
  const [{ n }] =
    await sql`SELECT count(*)::int AS n FROM properties WHERE street_view_status IS NOT NULL`;
  counts.alreadyChecked = n;
  let after = "",
    failuresInARow = 0;
  while (!stopped && (limit === null || counts.processed < limit)) {
    const batch = (id !== undefined
      ? await sql`SELECT id, address, lat, lng, street_lat, street_lng FROM properties WHERE id=${id} AND lat IS NOT NULL AND lng IS NOT NULL`
      : await sql`SELECT id, address, lat, lng, street_lat, street_lng FROM properties WHERE street_view_status IS NULL AND lat IS NOT NULL AND lng IS NOT NULL AND id > ${after} ORDER BY id LIMIT 500`) as unknown as (CheckTarget & {
      address: string | null;
    })[];
    if (!batch.length) {
      if (id !== undefined)
        console.log(`No property ${id} with a map position.`);
      break;
    }
    after = batch[batch.length - 1].id;
    const todo = batch.filter((p) => {
      const skip =
        id === undefined &&
        !retryUncertain &&
        earlier.get(p.id)?.outcome === "uncertain";
      if (skip) counts.skippedUncertain++;
      return !skip;
    });
    if (limit !== null) todo.splice(limit - counts.processed);
    const done: { id: string; result: CheckResult }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
        while (!stopped && next < todo.length) {
          const p = todo[next++];
          let result: CheckResult;
          try {
            result = await checkProperty(
              {
                id: p.id,
                lat: Number(p.lat),
                lng: Number(p.lng),
                streetLat: p.streetLat == null ? null : Number(p.streetLat),
                streetLng: p.streetLng == null ? null : Number(p.streetLng),
              },
              options,
            );
          } catch (error) {
            if (!(error instanceof StreetViewDenied)) throw error;
            stopped ||= error.message;
            return;
          }
          failuresInARow = result.outcome === "failed" ? failuresInARow + 1 : 0;
          // Many failures in a row mean the network or Google is the problem,
          // not the properties: stop instead of failing the whole county.
          if (failuresInARow >= 25)
            stopped ||= "25 checks failed in a row; run again later to resume";
          counts.processed++;
          counts[result.outcome]++;
          const line: Line = {
            id: p.id,
            address: p.address || "",
            outcome: result.outcome,
            detail: result.detail,
            at: new Date().toISOString(),
          };
          earlier.set(p.id, line);
          appendFileSync(checkpointFile, JSON.stringify(line) + "\n");
          done.push({ id: p.id, result });
          if (id !== undefined || (limit !== null && limit <= 20))
            console.log(
              `  ${p.id}  ${p.address || "(no address)"}  →  ${result.outcome}: ${result.detail}`,
            );
        }
      }),
    );
    await save(done);
    console.log(
      `${format.format(counts.processed)} checked · ${format.format(counts.available)} available · ${format.format(counts.none)} no Street View · ${format.format(counts.uncertain)} uncertain · ${format.format(counts.failed)} failed`,
    );
    if (id !== undefined) break;
  }
  writeReport();
  console.log(
    [
      "",
      stopped ? `Stopped early: ${stopped.replace(/\.$/, "")}.` : "Done.",
      `  Checked in this run:        ${format.format(counts.processed)}`,
      `  Street View available:      ${format.format(counts.available)}`,
      `  No Street View (confirmed): ${format.format(counts.none)}`,
      `  Uncertain (for review):     ${format.format(counts.uncertain)}`,
      `  Failed (will be retried):   ${format.format(counts.failed)}`,
      `  Already answered before:    ${format.format(counts.alreadyChecked)}`,
      `  Uncertain before, skipped:  ${format.format(counts.skippedUncertain)}`,
      `Report: ${reportFile}   For review: ${reviewFile}`,
    ].join("\n"),
  );
  if (stopped && stopped !== "interrupted") process.exitCode = 1;
} catch (error) {
  writeReport();
  console.error(`Failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
