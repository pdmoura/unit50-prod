import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import type { PropertyDetail, UploadTicket } from "../shared/types";
import { post, del } from "./api";

const MAX_BYTES = 15 * 1024 * 1024;
// Cloudinary resizes on the fly: a small square for the grid, the original on tap.
const thumbnail = (url: string) =>
  url.replace(
    "/image/upload/",
    "/image/upload/c_fill,w_240,h_240,q_auto,f_auto/",
  );
const full = (url: string) =>
  url.replace(
    "/image/upload/",
    "/image/upload/c_limit,w_1600,h_1600,q_auto,f_auto/",
  );

export default function PhotoSection({
  property: p,
  enabled,
  onChange,
}: {
  property: PropertyDetail;
  enabled: boolean;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const path = `/properties/${encodeURIComponent(p.id)}/photos`;
  async function add(file: File) {
    setError("");
    if (file.size > MAX_BYTES) {
      setError("That photo is over 15 MB. Choose a smaller one.");
      return;
    }
    setBusy("Uploading…");
    try {
      // The file goes straight to Cloudinary with a one-time signature from our server.
      const ticket = (await post(`${path}/ticket`, {})) as UploadTicket;
      const form = new FormData();
      for (const [name, value] of Object.entries(ticket.fields))
        form.append(name, value);
      form.append("file", file);
      const response = await fetch(ticket.uploadUrl, {
        method: "POST",
        body: form,
      });
      const uploaded = await response.json();
      if (!response.ok)
        throw new Error(
          uploaded.error?.message || "The photo could not be uploaded.",
        );
      await post(path, {
        publicId: uploaded.public_id,
        version: uploaded.version,
        signature: uploaded.signature,
        format: uploaded.format,
        width: uploaded.width,
        height: uploaded.height,
        bytes: uploaded.bytes,
      });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function remove(id: string) {
    if (!confirm("Remove this photo? It is deleted permanently.")) return;
    setError("");
    setBusy("Removing…");
    try {
      await del(`${path}/${encodeURIComponent(id)}`);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  if (!enabled && !p.photos.length) return null;
  return (
    <>
      <div className="section-title">
        <h3>Photos</h3>
        <span>{busy || `${p.photos.length} added`}</span>
      </div>
      {p.photos.length > 0 && (
        <div className="photo-grid">
          {p.photos.map((photo) => (
            <figure key={photo.id}>
              <a href={full(photo.url)} target="_blank" rel="noreferrer">
                <img
                  src={thumbnail(photo.url)}
                  alt={`Photo of ${p.address || `parcel ${p.id}`}`}
                  loading="lazy"
                />
              </a>
              {enabled && (
                <button
                  className="icon-button"
                  aria-label="Remove photo"
                  title="Remove photo"
                  disabled={Boolean(busy)}
                  onClick={() => void remove(photo.id)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </figure>
          ))}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {enabled && (
        <>
          <input
            ref={input}
            className="sr-only"
            type="file"
            accept="image/*"
            aria-label="Choose a photo"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void add(file);
            }}
          />
          <button
            className="secondary-button full"
            disabled={Boolean(busy)}
            onClick={() => input.current?.click()}
          >
            <Camera size={16} />
            {busy || "Add photo"}
          </button>
        </>
      )}
    </>
  );
}
