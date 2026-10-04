import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Sign-in is handled by Supabase Auth. The server says where it lives through
// /api/config; when it returns nothing, the app runs without sign-in (local use).
let client: SupabaseClient | null = null;

export async function initAuth(): Promise<SupabaseClient | null> {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("The server could not be reached.");
  const { auth } = (await response.json()) as {
    auth: { url: string; key: string } | null;
  };
  if (!auth) return null;
  client = createClient(auth.url, auth.key, {
    auth: {
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
// Ends the session in this browser, for example after the server rejects it.
export async function signOutHere() {
  await client?.auth.signOut({ scope: "local" });
}
