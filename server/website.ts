// Settings that live on the Unit 50 website (unit50-studio) and that admins
// change from here: for now, the careers page (open or closed, and its text).
//
// The website keeps them in its own database, so it never waits on this app.
// This app reads and writes them through the website's /api/admin/careers,
// signed with the secret the two already share for leads. The signed text
// includes the method and path, so it can never be confused with a lead
// delivery.
import { createHmac } from "node:crypto";
import { AppError } from "./db.js";
import type { CareersSettings } from "../shared/types.js";

export const CAREERS_PATH = "/api/admin/careers";

export function signRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
) {
  const ts = Math.floor(now / 1000);
  return {
    "X-Unit50-Timestamp": String(ts),
    "X-Unit50-Signature": createHmac("sha256", secret)
      .update(`${ts}.${method}.${path}.${body}`)
      .digest("hex"),
  };
}

export async function websiteCareers(
  options: {
    website: string;
    secret: string | null;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  },
  change?: Omit<CareersSettings, "updatedAt">,
): Promise<CareersSettings> {
  if (!options.secret)
    throw new AppError(
      503,
      "The website is not connected yet. Set LEADS_WEBHOOK_SECRET on this server and WEBHOOK_SECRET on the website.",
    );
  const method = change ? "PUT" : "GET",
    body = change ? JSON.stringify(change) : "";
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(
      `${options.website}${CAREERS_PATH}`,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(change ? { "Content-Type": "application/json" } : {}),
          ...signRequest(options.secret, method, CAREERS_PATH, body),
        },
        body: change ? body : undefined,
        // A free website instance can take most of a minute to wake up.
        signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
      },
    );
  } catch {
    throw new AppError(
      502,
      "The website did not answer. It may be waking up; try again in a minute.",
    );
  }
  const data = (await response.json().catch(() => null)) as {
    careers?: CareersSettings;
    message?: string;
  } | null;
  if (!response.ok || !data?.careers)
    throw new AppError(
      response.status === 400 ? 400 : 502,
      response.status === 400
        ? `The website refused the change: ${data?.message || "check the fields"}.`
        : response.status === 401
          ? "The website refused this app's signature. Check that both use the same secret."
          : `The website answered with an error (HTTP ${response.status}).`,
    );
  return data.careers;
}
