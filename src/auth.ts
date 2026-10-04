import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Sign-in is handled by Supabase Auth. The server says where it lives through
// /api/config; when it returns nothing, the app runs without sign-in (local use).
let client: SupabaseClient | null = null;
const STORAGE_KEY = "unit50-auth";

export async function initAuth(): Promise<SupabaseClient | null> {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("The server could not be reached.");
  const { auth } = (await response.json()) as {
    auth: { url: string; key: string } | null;
  };
  if (!auth) return null;
  client = createClient(auth.url, auth.key, {
    auth: {
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
// The current access token; the library renews it shortly before it expires.
export async function accessToken() {
  if (!client) return null;
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}
// Signs this device out. Supabase deletes the session, so its token and its
// renewal token stop working; other devices the person uses stay signed in.
export async function signOut() {
  if (!client) return;
  const token = await accessToken();
  // Our server forgets the token first, so it is refused from the next request.
  if (token)
    await fetch("/api/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  const failed = await client.auth
    .signOut({ scope: "local" })
    .then((result) => Boolean(result.error))
    .catch(() => true);
  if (failed) {
    // Supabase could not be reached. The session is still removed from this
    // device, and a reload discards the copy held in memory.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    location.reload();
  }
}
