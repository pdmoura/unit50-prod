import { useEffect, useState } from "react";
import {
  X,
  ArrowUpRight,
  MapPin,
  CalendarDays,
  Plus,
  Check,
  Clock,
  History,
  ShieldOff,
  Info,
  Navigation,
  Eye,
} from "lucide-react";
import {
  STATUSES,
  UTAH_ZONE,
  utahToday,
  type PropertyDetail,
  type ProspectStatus,
  type FollowUp,
} from "../shared/types";
import { post, patch } from "./api";
import CountyPanel from "./CountyPanel";
import PhotoSection from "./PhotoSection";
// Opens Street View on the road in front of the property, facing it. Without
// a heading Google faces north, so the stored road point and direction are
// used when known; the parcel position alone is the fallback.
export function streetViewUrl(p: {
  lat: number | null;
  lng: number | null;
  streetLat: number | null;
  streetLng: number | null;
  streetHeading: number | null;
}) {
  const base = "https://www.google.com/maps/@?api=1&map_action=pano";
  return p.streetLat != null && p.streetLng != null && p.streetHeading != null
    ? `${base}&viewpoint=${p.streetLat.toFixed(6)},${p.streetLng.toFixed(6)}&heading=${Math.round(p.streetHeading)}&pitch=0&fov=80`
    : `${base}&viewpoint=${p.lat},${p.lng}`;
}
export function Badge({ value }: { value: string }) {
  return (
    <span className={`badge ${value.toLowerCase().replaceAll(" ", "-")}`}>
      {value}
    </span>
  );
}
export function eventTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: UTAH_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
export function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value + "T12:00:00Z"));
}
// The name part of a sign-in email, to say who did something.
export const who = (email: string | null) => (email ? email.split("@")[0] : "");
export function TaskRow({
  task,
  onChange,
  onOpen,
  showOwner = false,
}: {
  task: FollowUp;
  onChange: () => void;
  onOpen?: (id: string) => void;
  // On the team view, say whose follow-up it is.
  showOwner?: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [date, setDate] = useState(task.dueDate),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setDate(task.dueDate), [task.dueDate]);
  async function update(data: unknown) {
    setBusy(true);
    setError("");
    try {
      await patch(`/follow-ups/${task.id}`, data);
      setEditing(false);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`task-row ${task.state !== "pending" ? "task-done" : ""}`}>
      <div className="task-date">
        <CalendarDays size={17} />
        <span>{dateLabel(task.dueDate)}</span>
      </div>
      <div className="task-main">
        {onOpen ? (
          <button
            className="text-link task-address"
            onClick={() => onOpen(task.propertyId)}
          >
            {task.address || `Parcel ${task.propertyId}`}
            <ArrowUpRight size={14} />
          </button>
        ) : (
          <strong>{task.notes || "Follow up with homeowner"}</strong>
        )}
        {onOpen && <p>{task.notes || task.city}</p>}
        <span className="micro">
          {task.state === "pending"
            ? task.dueDate < utahToday()
              ? "Overdue"
              : task.dueDate === utahToday()
                ? "Due today"
                : "Upcoming"
            : task.state}
          {showOwner && (
            <span title={task.createdBy || undefined}>
              {" · "}
              {task.createdBy ? who(task.createdBy) : "no owner"}
            </span>
          )}
        </span>
      </div>
      {task.state === "pending" && (
        <div className="task-actions">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void update({ dueDate: date });
              }}
            >
              <label className="sr-only" htmlFor={`reschedule-${task.id}`}>
                New follow-up date
              </label>
              <input
                id={`reschedule-${task.id}`}
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <button className="small-button" disabled={busy}>
                Save
              </button>
              <button
                type="button"
                className="text-link"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button
                className="icon-button"
                aria-label="Reschedule follow-up"
                title="Reschedule"
                onClick={() => setEditing(true)}
              >
                <CalendarDays size={17} />
              </button>
              <button
                className="icon-button complete"
                disabled={busy}
                aria-label="Complete follow-up"
                title="Complete"
                onClick={() => void update({ state: "completed" })}
              >
                <Check size={18} />
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export default function DetailPanel({
  property: p,
  photosEnabled,
  onClose,
  onChange,
}: {
  property: PropertyDetail;
  photosEnabled: boolean;
  onClose: () => void;
  onChange: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "county" | "activity">(
      "overview",
    ),
    [form, setForm] = useState<"visit" | "followup" | null>(null),
    [result, setResult] = useState<ProspectStatus>("No answer"),
    [notes, setNotes] = useState(""),
    [date, setDate] = useState(utahToday()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const blocked = p.status === "Do not contact" || !p.active;
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [onClose]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      setForm(null);
      setNotes("");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="detail-panel" aria-label="Property details">
      <div className="detail-top">
        <span className="eyebrow">PROPERTY DETAILS</span>
        <button
          className="icon-button"
          aria-label="Close property details"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="detail-scroll">
        <div className="property-heading">
          <div className="parcel-icon">
            <MapPin size={27} strokeWidth={1.5} />
          </div>
          <h2>{p.address || "Address unavailable"}</h2>
          <p>
            {p.city}
            {p.zip ? `, UT ${p.zip}` : ""}
          </p>
          {p.owner && <p className="owner-line">{p.owner}</p>}
          <span className="micro">PARCEL {p.id}</span>
          <div className="detail-badges">
            <Badge value={`${p.priority} priority`} />
            {!p.active && <Badge value="Inactive" />}
          </div>
          {(p.lat != null || p.address) && (
            <div className="detail-links">
              {p.lat != null && p.lng != null && (
                <a
                  className="secondary-button"
                  href={streetViewUrl(p)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Eye size={15} />
                  Street View
                </a>
              )}
              <a
                className="secondary-button"
                href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
                  p.address
                    ? `${p.address}, ${p.city}, UT ${p.zip}`
                    : `${p.lat},${p.lng}`,
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                <Navigation size={15} />
                Navigate
              </a>
            </div>
          )}
        </div>
        <div className="detail-tabs">
          <button
            className={tab === "overview" ? "selected" : ""}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            className={tab === "county" ? "selected" : ""}
            onClick={() => setTab("county")}
          >
            County
          </button>
          <button
            className={tab === "activity" ? "selected" : ""}
            onClick={() => setTab("activity")}
          >
            Activity <span>{p.visits.length}</span>
          </button>
        </div>
        {tab === "county" ? (
          <CountyPanel property={p} onChange={onChange} />
        ) : tab === "overview" ? (
          <>
            <div className="priority-box">
              <div>
                <span className="eyebrow">AGE-BASED PRIORITY</span>
                <Badge value={p.priority} />
              </div>
              <strong>
                {p.age === null
                  ? "Construction age unknown"
                  : `Estimated building age: ${p.age} years`}
              </strong>
              <p>
                {p.age === null
                  ? "Insufficient or conflicting county data."
                  : p.priority === "High"
                    ? "40+ years · prioritized for initial outreach"
                    : p.priority === "Medium"
                      ? "20–39 years · secondary outreach"
                      : "Under 20 years · lower initial priority"}
              </p>
              <small>
                Age is a prospecting signal, not a prediction of purchase or
                proof that a home needs repairs.
              </small>
            </div>
            <div className="detail-grid">
              <div>
                <span>Construction year*</span>
                <strong>{p.year ?? "Unknown"}</strong>
              </div>
              <div>
                <span>Residential area</span>
                <strong>
                  {p.sqft != null
                    ? `${p.sqft.toLocaleString()} sq ft`
                    : "Unknown"}
                </strong>
              </div>
              <div>
                <span>Property type</span>
                <strong>Single-family</strong>
              </div>
              <div>
                <span>Map position</span>
                <strong>{p.lng !== null ? "Available" : "Unavailable"}</strong>
              </div>
            </div>
            <p className="field-note">
              *County field WGT_AVE_RI_YB may be a weighted average. It is not a
              verified construction date.
            </p>
            {p.issues.length > 0 && (
              <div className="notice">
                <Info size={17} />
                <div>
                  <strong>Data notes</strong>
                  {p.issues.map((x) => (
                    <p key={x}>{x}</p>
                  ))}
                </div>
              </div>
            )}
            <label className="field-label" htmlFor="prospect-status">
              CONTACT STATUS
            </label>
            <select
              id="prospect-status"
              value={p.status}
              disabled={busy}
              onChange={(e) =>
                void action(() =>
                  patch(`/properties/${encodeURIComponent(p.id)}/prospect`, {
                    status: e.target.value,
                  }),
                )
              }
            >
              {STATUSES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <p className="field-note">
              “Do not contact” cancels pending returns and blocks new ones.
            </p>
          </>
        ) : (
          <div className="activity-list">
            {p.visits.length === 0 ? (
              <div className="empty-small">
                <History size={27} />
                <strong>No visits yet</strong>
                <p>Your first visit starts the story.</p>
              </div>
            ) : (
              p.visits.map((v) => (
                <article className="activity" key={v.id}>
                  <span className="activity-point" />
                  <div>
                    <strong>{v.result}</strong>
                    <time>
                      {eventTime(v.occurredAt)} · Utah
                      {v.createdBy && (
                        <span title={v.createdBy}> · {who(v.createdBy)}</span>
                      )}
                    </time>
                    {v.notes && <p>{v.notes}</p>}
                  </div>
                </article>
              ))
            )}
          </div>
        )}
        <PhotoSection
          property={p}
          enabled={photosEnabled}
          onChange={onChange}
        />
        <div className="section-title">
          <h3>Follow-ups</h3>
          <span>
            {p.followUps.filter((t) => t.state === "pending").length} pending
          </span>
        </div>
        {p.followUps.length ? (
          p.followUps.map((t) => (
            <TaskRow key={t.id} task={t} onChange={onChange} />
          ))
        ) : (
          <p className="muted small">No follow-up scheduled.</p>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {form && (
          <form
            className="entry-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action(() =>
                form === "visit"
                  ? post(`/properties/${encodeURIComponent(p.id)}/visits`, {
                      result,
                      notes,
                    })
                  : post("/follow-ups", {
                      propertyId: p.id,
                      dueDate: date,
                      notes,
                    }),
              );
            }}
          >
            <div className="section-title">
              <h3>
                {form === "visit" ? "Log a visit" : "Schedule a follow-up"}
              </h3>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel entry"
                onClick={() => setForm(null)}
              >
                <X size={16} />
              </button>
            </div>
            {form === "visit" ? (
              <label>
                Visit result
                <select
                  value={result}
                  onChange={(e) => setResult(e.target.value as ProspectStatus)}
                >
                  {STATUSES.filter((x) => x !== "Not visited").map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Follow-up date
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
            )}
            <label>
              Notes
              <textarea
                placeholder={
                  form === "visit"
                    ? "What happened at the door?"
                    : "What should you follow up on?"
                }
                value={notes}
                maxLength={form === "visit" ? 5000 : 2000}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </label>
            <button className="primary-button full" disabled={busy || blocked}>
              {busy
                ? "Saving…"
                : form === "visit"
                  ? "Save visit"
                  : "Save follow-up"}
            </button>
          </form>
        )}
        <div className="source-note">
          <span className="eyebrow">COUNTY RECORD</span>
          <p>Updated {eventTime(p.sourceAt)}</p>
          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
            Weber County · Parcel Master <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
      <div className="detail-footer">
        {blocked ? (
          <p>
            <ShieldOff size={17} />
            {!p.active
              ? "Inactive county record"
              : "Do not contact · outreach is paused"}
          </p>
        ) : (
          <>
            <button
              className="primary-button"
              onClick={() => {
                setForm("visit");
                setError("");
                setTimeout(
                  () =>
                    document
                      .querySelector(".entry-form")
                      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                  50,
                );
              }}
            >
              <Plus size={17} />
              Log visit
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setForm("followup");
                setError("");
                setTimeout(
                  () =>
                    document
                      .querySelector(".entry-form")
                      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
                  50,
                );
              }}
            >
              <CalendarDays size={17} />
              Follow up
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
