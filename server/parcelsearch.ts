import type { Db } from "./db.js";
import {
  PARCEL_SEARCH_URL,
  type CountyBuilding,
  type CountyDetails,
  type DetailsRun,
} from "../shared/types.js";

// Weber County Parcel Search (webercountyutah.gov/parcelsearch) publishes
// building-level characteristics, loan company and tax line items that the
// ArcGIS parcel layer does not carry. Pages are plain server-rendered HTML.
export interface PageFetcher {
  (path: string): Promise<string>;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const countyFetcher: PageFetcher = async (path) => {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${PARCEL_SEARCH_URL}/${path}`, {
        signal: AbortSignal.timeout(30000),
        headers: { "User-Agent": "Unit50-Local-MVP/1.0" },
      });
      if (!response.ok)
        throw new Error(`Parcel Search returned HTTP ${response.status}`);
      return await response.text();
    } catch (e) {
      last = e;
      if (attempt < 2) await pause(1500 * 2 ** attempt);
    }
  }
  throw last;
};

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
};
export function clean(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<sup>2<\/sup>/gi, "²")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(
            e[1].toLowerCase() === "x"
              ? parseInt(e.slice(2), 16)
              : Number(e.slice(1)),
          )
        : (entities[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();
}
function money(v: string | undefined) {
  if (!v) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return v.trim() === "-" || !Number.isFinite(n) ? null : n;
}
function numeric(v: string | undefined) {
  if (!v) return null;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
// Values in the tax summary follow a <strong>Label</strong> heading.
function labelled(html: string, label: string) {
  const m = html.match(
    new RegExp(
      `<strong>\\s*${label}\\s*</strong>[\\s\\S]*?(?:<br>|</div>\\s*<div[^>]*>(?:\\s*<div[^>]*>)?)([\\s\\S]*?)</div>`,
      "i",
    ),
  );
  return m ? clean(m[1]) : undefined;
}
// The direct charge and payment lists are rows of four col-md-3 cells.
function cellRows(section: string) {
  const rows: string[][] = [];
  for (const row of section.split(/<div class=['"]row['"]>/i).slice(1)) {
    const cells = [
      ...row.matchAll(/<div class=['"]col-md-3['"]>([\s\S]*?)<\/div>/gi),
    ].map((m) => clean(m[1]));
    if (
      cells.length === 4 &&
      cells.some(Boolean) &&
      !/^Type$|^Pay Date$/.test(cells[0])
    )
      rows.push(cells);
  }
  return rows;
}
export function parseCurrentTaxes(html: string) {
  if (!/Parcel Summary/i.test(html) || !/Property Owner/i.test(html))
    throw new Error("Parcel Search returned no tax record for this parcel.");
  const owner = html.match(
    /<strong>Property Owner &amp; Address<\/strong>\s*\(([^)]*)\)<br>([\s\S]*?)<br>/i,
  );
  const loan = clean(
    html.match(/<strong>Loan Company:<\/strong>\s*<br>([\s\S]*?)<br>/i)?.[1] ||
      "",
  );
  const year = html.match(/Year:\s*(\d{4})/);
  const detail = html.split(/<strong>Tax Detail<\/strong>/i)[1] || "",
    [direct, payments = ""] = detail.split(/<strong>Payments<\/strong>/i);
  const result = {
    taxYear: year ? Number(year[1]) : null,
    ownerAsOf: owner ? clean(owner[1]) : null,
    owner: owner ? clean(owner[2]) : null,
    loanCompany: !loan || /^none$/i.test(loan) ? null : loan,
    taxArea: numeric(
      html.match(/<strong>Tax Area<\/strong>\s*<br>([\s\S]*?)<br>/i)?.[1],
    ),
    marketValue: money(labelled(html, "Market")),
    taxableValue: money(labelled(html, "Taxable")?.replace(/X$/, "")),
    taxRate: numeric(labelled(html, "Rate")),
    netAssessment: money(labelled(html, "Net Assessment Charge")),
    directTotal: money(labelled(html, "Total Direct")),
    penalty: money(labelled(html, "Penalty Charge")),
    subtotal: money(labelled(html, "Sub Total")),
    paymentsTotal: money(labelled(html, "Total Payments")),
    balance: money(labelled(html, "Balance")),
    directCharges: cellRows(direct).map(
      ([type, description, amount, status]) => ({
        type,
        description,
        amount: money(amount),
        status,
      }),
    ),
    payments: cellRows(payments).map(([date, payee, amount, status]) => ({
      date,
      payee,
      amount: money(amount),
      status,
    })),
  };
  if (!result.owner && result.marketValue === null)
    throw new Error("Parcel Search returned no tax record for this parcel.");
  return result;
}
function tableRows(html: string) {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(
    /<tr>\s*<td[^>]*>\s*<strong>([^<]+?):?\s*<\/strong>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi,
  ))
    out[clean(m[1]).replace(/:$/, "")] = clean(m[2]);
  return out;
}
export function parseCharacteristics(html: string) {
  const [lotHtml = "", buildingHtml = ""] = html.split(
    /<h4><strong>Building Characteristics<\/strong><\/h4>/i,
  );
  const lot = tableRows(lotHtml);
  // Unknown parcels render the page template with an empty table.
  if (!lot["Lot Size"] && !/Building #/i.test(buildingHtml))
    throw new Error(
      "Parcel Search returned no characteristics for this parcel.",
    );
  const buildings: CountyBuilding[] = [];
  for (const block of buildingHtml.split(/<h5><strong>Building #/i).slice(1)) {
    const r = tableRows(block.split(/<\/table>/i)[0]);
    buildings.push({
      number: Number(block.match(/^(\d+)/)?.[1] ?? buildings.length + 1),
      type: r["Property Type"] || null,
      style: r["Style"] || null,
      exterior: r["Exterior"] || null,
      roof: r["Roof Cover"] || null,
      quality: r["Quality"] || null,
      year: numeric(r["Year of Construction"]),
      livingSqft: numeric(r["Gross Living Area (Above-Grade)"]),
      percentComplete: numeric(r["Percent Complete"]),
      basementSqft: numeric(r["Basement Square Feet"]),
      basementFinishPct: numeric(r["Basement Finish Percentage"]),
    });
  }
  const sketches = [
    ...html.matchAll(/<img src='(https:\/\/[^']+\/sketches\/[^']+)'/gi),
  ].map((m) => m[1]);
  const platMaps = [
    ...html.matchAll(/href=["']?(https:\/\/[^"' >]+Platmaps\/[^"' >]+\.PDF)/gi),
  ].map((m) => m[1]);
  return {
    assessmentYear: numeric(lot["Assessment Data Year"]),
    acres: numeric(lot["Lot Size"]),
    greenbelt: lot["FAA/Greenbelt"] ? /^yes/i.test(lot["FAA/Greenbelt"]) : null,
    landType: lot["Land Type"] || null,
    neighborhood: lot["Neighborhood"] || null,
    buildings,
    sketches,
    platMaps,
  };
}
export async function fetchCountyDetails(
  id: string,
  fetcher: PageFetcher = countyFetcher,
): Promise<CountyDetails> {
  const q = encodeURIComponent(id);
  const [taxes, characteristics] = await Promise.all([
    fetcher(`current-taxes.php?id=${q}`).then(parseCurrentTaxes),
    fetcher(`property-characteristics.php?id=${q}`).then(parseCharacteristics),
  ]);
  return { taxes, characteristics };
}
export async function saveCountyDetails(
  sql: Db,
  id: string,
  result: { data: CountyDetails } | { error: string },
) {
  const now = new Date().toISOString();
  if ("data" in result)
    await sql`INSERT INTO county_details (property_id, state, fetched_at, error, data) VALUES (${id}, 'ok', ${now}, NULL, ${sql.json(result.data as any)}) ON CONFLICT (property_id) DO UPDATE SET state='ok', fetched_at=excluded.fetched_at, error=NULL, data=excluded.data`;
  // A failed refresh keeps the last good data and only records the error.
  else
    await sql`INSERT INTO county_details (property_id, state, fetched_at, error, data) VALUES (${id}, 'error', ${now}, ${result.error}, NULL) ON CONFLICT (property_id) DO UPDATE SET state='error', fetched_at=excluded.fetched_at, error=excluded.error`;
}
export async function refreshCountyDetails(
  sql: Db,
  id: string,
  fetcher: PageFetcher = countyFetcher,
) {
  try {
    await saveCountyDetails(sql, id, {
      data: await fetchCountyDetails(id, fetcher),
    });
    return true;
  } catch (e) {
    await saveCountyDetails(sql, id, {
      error: e instanceof Error ? e.message : "Parcel Search request failed.",
    });
    return false;
  }
}
export async function detailsRun(
  sql: Db,
  id?: string,
): Promise<DetailsRun | null> {
  const rows = id
    ? await sql`SELECT * FROM details_runs WHERE id=${id}`
    : await sql`SELECT * FROM details_runs ORDER BY started_at DESC LIMIT 1`;
  return (rows[0] as DetailsRun | undefined) || null;
}
// Walks every active parcel that still lacks Parcel Search data (in "refresh"
// mode, also parcels fetched more than refreshDays ago). Fetched parcels are
// skipped, so a stopped or interrupted run resumes where it left off.
export async function runCountyDetails(
  sql: Db,
  runId: string,
  options: {
    mode?: "missing" | "refresh";
    refreshDays?: number;
    concurrency?: number;
    delayMs?: number;
    fetcher?: PageFetcher;
  } = {},
) {
  const { mode = "missing", concurrency = 3, delayMs = 250 } = options;
  const staleBefore = new Date(
    Date.now() - (options.refreshDays ?? 30) * 86400000,
  ).toISOString();
  try {
    const ids = (
      await sql`SELECT p.id FROM properties p LEFT JOIN county_details d ON d.property_id=p.id WHERE p.active AND (d.property_id IS NULL OR d.state='error' ${mode === "refresh" ? sql`OR d.fetched_at<${staleBefore}` : sql``}) ORDER BY p.id`
    ).map((r) => String(r.id));
    await sql`UPDATE details_runs SET total=${ids.length}, message=${ids.length ? "Reading Weber County Parcel Search…" : "Nothing to fetch."} WHERE id=${runId}`;
    let next = 0,
      processed = 0,
      failed = 0,
      stopped = false;
    async function lane() {
      while (!stopped && next < ids.length) {
        const id = ids[next++];
        if (!(await refreshCountyDetails(sql, id, options.fetcher))) failed++;
        processed++;
        await sql`UPDATE details_runs SET processed=${processed}, failed=${failed} WHERE id=${runId}`;
        const [stopping] =
          await sql`SELECT 1 FROM details_runs WHERE id=${runId} AND state='stopping'`;
        if (stopping) stopped = true;
        else if (delayMs) await pause(delayMs);
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
    await sql`UPDATE details_runs SET state=${stopped ? "stopped" : "completed"}, finished_at=${new Date().toISOString()}, message=${
      stopped
        ? "Stopped. Start again to resume where it left off."
        : failed
          ? `Finished. ${failed} parcels could not be read; start again to retry them.`
          : "Every parcel has Parcel Search details."
    } WHERE id=${runId}`;
  } catch (error) {
    await sql`UPDATE details_runs SET state='failed', finished_at=${new Date().toISOString()}, message=${error instanceof Error ? error.message : "Parcel Search run failed"} WHERE id=${runId}`;
  }
}
