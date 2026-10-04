import { accessToken } from "./auth";

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = await accessToken();
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  // The session ended or the account was disabled: back to the sign-in screen.
  if (response.status === 401 && token)
    window.dispatchEvent(new Event("unit50:signed-out"));
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}
export function query(values: Record<string, unknown>) {
  return new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== "" && v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}
export const post = (path: string, body: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api(path, { method: "DELETE" });
