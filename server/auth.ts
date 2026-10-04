import { AppError } from "./db.js";

// Sign-in is handled by Supabase Auth: the browser signs in there and sends the
// resulting access token with every API request. Supabase proves who the person
// is; the app_users table decides whether they may use Unit 50, so an account
// someone creates on their own never gets in.
export interface AuthConfig {
  url: string;
  key: string;
}
export interface AuthUser {
  id: string;
  email: string;
}
export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

// The project URL and publishable key are public values (the browser needs them).
export function authConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig | null {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL,
    key = env.SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url: url.replace(/\/+$/, ""), key } : null;
}
// Asks Supabase who the token belongs to. That also covers expiry, sign-out and
// banned accounts, which checking the token's signature alone would miss.
export function supabaseVerifier(
  config: AuthConfig,
  fetcher: typeof fetch = fetch,
): TokenVerifier {
  return async (token) => {
    const response = await fetcher(`${config.url}/auth/v1/user`, {
      headers: { apikey: config.key, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok)
      throw new AppError(503, "Sign-in is unavailable right now. Try again.");
    const user = (await response.json()) as {
      id?: string;
      email?: string;
      email_confirmed_at?: string | null;
    };
    // An unconfirmed address proves nothing about who owns it.
    if (!user.id || !user.email || !user.email_confirmed_at) return null;
    return { id: user.id, email: user.email.toLowerCase() };
  };
}
// Remembers recent answers so one page load does not ask Supabase a dozen times.
export function cached(verify: TokenVerifier, ttlMs = 60000): TokenVerifier {
  const seen = new Map<string, { user: AuthUser | null; expires: number }>();
  return async (token) => {
    const hit = seen.get(token);
    if (hit && hit.expires > Date.now()) return hit.user;
    const user = await verify(token);
    if (seen.size >= 1000) seen.clear();
    seen.set(token, { user, expires: Date.now() + ttlMs });
    return user;
  };
}
