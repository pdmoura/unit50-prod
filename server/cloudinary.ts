import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

// Property photos are stored in Cloudinary. The browser uploads the file
// straight to Cloudinary with a short-lived signature from this server, so the
// API secret never leaves the server.
export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  folder: string;
  algorithm: "sha1" | "sha256";
}
export type Fetcher = typeof fetch;
export const PHOTO_FORMATS = "jpg,jpeg,png,webp,heic,heif";
export const MAX_PHOTOS_PER_PROPERTY = 30;

export function cloudinaryConfig(
  env: Record<string, string | undefined> = process.env,
): CloudinaryConfig | null {
  const {
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret,
  } = env;
  if (!cloudName || !apiKey || !apiSecret) return null;
  return {
    cloudName,
    apiKey,
    apiSecret,
    folder: env.CLOUDINARY_FOLDER || "unit50-uploads",
    algorithm:
      env.CLOUDINARY_SIGNATURE_ALGORITHM === "sha256" ? "sha256" : "sha1",
  };
}
// Cloudinary signs the parameters sorted by name, joined as a query string,
// with the API secret appended.
export function sign(config: CloudinaryConfig, params: Record<string, string>) {
  const toSign = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return createHash(config.algorithm)
    .update(toSign + config.apiSecret)
    .digest("hex");
}
export const photoPrefix = (propertyId: string) => `property-${propertyId}-`;
// Everything the browser needs to upload one photo for one property. The
// signature covers the folder, the public id and the allowed formats, so the
// ticket cannot be reused to upload anywhere else.
export function uploadTicket(config: CloudinaryConfig, propertyId: string) {
  const params = {
    allowed_formats: PHOTO_FORMATS,
    asset_folder: config.folder,
    public_id: `${photoPrefix(propertyId)}${randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/upload`,
    fields: {
      ...params,
      api_key: config.apiKey,
      signature: sign(config, params),
    },
  };
}
// Cloudinary signs each upload response; checking it proves the browser is
// reporting a real upload to this account and not an arbitrary URL.
export function verifyUpload(
  config: CloudinaryConfig,
  upload: { publicId: string; version: number; signature: string },
) {
  const expected = Buffer.from(
      sign(config, {
        public_id: upload.publicId,
        version: String(upload.version),
      }),
    ),
    given = Buffer.from(upload.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
export function photoUrl(
  config: CloudinaryConfig,
  publicId: string,
  version: number,
  format: string,
) {
  return `https://res.cloudinary.com/${encodeURIComponent(config.cloudName)}/image/upload/v${version}/${publicId.split("/").map(encodeURIComponent).join("/")}.${format}`;
}
// Removes the image from Cloudinary. "not found" counts as removed, so a photo
// already deleted there can still be cleared from the property.
export async function destroyPhoto(
  config: CloudinaryConfig,
  publicId: string,
  fetcher: Fetcher = fetch,
) {
  // invalidate also clears the copies Cloudinary's CDN has cached.
  const params = {
    invalidate: "true",
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const response = await fetcher(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/destroy`,
    {
      method: "POST",
      body: new URLSearchParams({
        ...params,
        api_key: config.apiKey,
        signature: sign(config, params),
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = (await response.json().catch(() => ({}))) as {
    result?: string;
    error?: { message?: string };
  };
  if (!response.ok || !["ok", "not found"].includes(data.result || ""))
    throw new Error(
      data.error?.message || `Cloudinary returned HTTP ${response.status}`,
    );
}
