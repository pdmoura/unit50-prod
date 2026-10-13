import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  CalendarCheck,
  Inbox,
  MessageSquare,
  Navigation,
  Phone,
  ShieldAlert,
  ShieldCheck,
  SquareKanban,
  UserRound,
  X,
} from "lucide-react";
import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  type Lead,
  type LeadStage,
  type PropertyPhoto,
} from "../shared/types";
import { api, patch } from "./api";
import { useAccount } from "./AuthGate";
import { eventTime } from "./DetailPanel";
import PhotoViewer from "./PhotoViewer";

// The board's columns: the shared pool first, then the pipeline stages.
type Column = "pool" | LeadStage;
const COLUMNS: Column[] = ["pool", ...LEAD_STAGES];
const columnLabel = (c: Column) =>
  c === "pool" ? "Unassigned" : LEAD_STAGE_LABELS[c];
const columnOf = (lead: Lead): Column => (lead.owner ? lead.stage : "pool");
const CHANGE_LABELS: Record<string, string> = {
  siding: "Siding",
  windows: "Windows",
  both: "Siding and windows",
};
const phoneLabel = (e164: string) =>
  /^\+1(\d{3})(\d{3})(\d{4})$/.test(e164)
    ? e164.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3")
    : e164;
const ago = (value: string) => {
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
};

// Leads from the website, as a pipeline. A rep sees the shared pool and their
// own leads; an admin sees everyone's and can choose whose board to look at.
export default function LeadsView({
  version,
  onOpenProperty,
}: {
  version: number;
  onOpenProperty: (id: string) => void;
}) {
  const account = useAccount(),
    admin = account.role === "admin";
  const [items, setItems] = useState<Lead[]>([]),
    [team, setTeam] = useState<string[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [person, setPerson] = useState("all"),
    [openId, setOpenId] = useState<string | null>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [over, setOver] = useState<Column | null>(null),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ items: Lead[]; team: string[] }>("/leads")
      .then((d) => {
        if (!live) return;
        setItems(d.items);
        setTeam(d.team);
        setLoaded(true);
        setError("");
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [version, tick]);
  // New website leads show up without a reload.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);
  const save = useCallback(
    async (
      lead: Lead,
      change: Partial<Pick<Lead, "stage" | "notes" | "owner">>,
    ) => {
      setError("");
      try {
        const saved = await patch(
          `/leads/${encodeURIComponent(lead.id)}`,
          change,
        );
        setItems((list) =>
          list.map((l) => (l.id === lead.id ? (saved as Lead) : l)),
        );
        return true;
      } catch (e) {
        setError((e as Error).message);
        setTick((n) => n + 1);
        return false;
      }
    },
    [],
  );
  // Moving a card: into the pool hands it back; into a stage takes it from the
  // pool (an admin who moves a pool lead takes it themselves).
  function move(lead: Lead, to: Column) {
    if (columnOf(lead) === to) return;
    if (to === "pool") return void save(lead, { owner: null });
    void save(
      lead,
      !lead.owner && account.email
        ? { stage: to, owner: account.email }
        : { stage: to },
    );
  }
  const shown = useMemo(
    () =>
      items.filter(
        (l) => !admin || person === "all" || !l.owner || l.owner === person,
      ),
    [items, admin, person],
  );
  const open = items.find((l) => l.id === openId) || null;
  return (
    <section className="content-section leads-section">
      <div className="section-toolbar leads-toolbar">
        <div>
          <strong className="leads-count">
            {shown.filter((l) => l.owner).length} in progress ·{" "}
            {shown.filter((l) => !l.owner).length} unassigned
          </strong>
          <span className="muted small">
            New leads from the website arrive in Unassigned.
            {admin ? "" : " Move one to a stage to take it."}
          </span>
        </div>
        {admin && team.length > 0 && (
          <label className="lead-person">
            <span className="sr-only">Show the board of</span>
            <select value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="all">Everyone</option>
              {team.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {loaded && !items.length ? (
        <div className="large-empty">
          <div className="empty-emblem">
            <SquareKanban size={38} strokeWidth={1.3} />
          </div>
          <span className="eyebrow">YOUR PIPELINE STARTS HERE</span>
          <h2>No website leads yet.</h2>
          <p>
            When a homeowner leaves their number in the exterior studio, the
            lead appears here, ready for a rep to take.
          </p>
        </div>
      ) : (
        <div className="lead-board" aria-label="Lead pipeline">
          {COLUMNS.map((column) => {
            const cards = shown.filter((l) => columnOf(l) === column);
            return (
              <section
                key={column}
                className={`lead-column ${column === "pool" ? "pool" : ""} ${over === column ? "drop-target" : ""}`}
                aria-label={columnLabel(column)}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  setOver(column);
                }}
                onDragLeave={() => setOver((c) => (c === column ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  const lead = items.find((l) => l.id === dragging);
                  setDragging(null);
                  setOver(null);
                  if (lead) move(lead, column);
                }}
              >
                <h3>
                  {column === "pool" && <Inbox size={14} />}
                  {columnLabel(column)}
                  <span>{cards.length}</span>
                </h3>
                <div className="lead-cards">
                  {cards.map((lead) => (
                    <button
                      key={lead.id}
                      className={`lead-card ${dragging === lead.id ? "dragging" : ""}`}
                      draggable={
                        !lead.owner || admin || lead.owner === account.email
                      }
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", lead.id);
                        setDragging(lead.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onClick={() => setOpenId(lead.id)}
                    >
                      <strong>{lead.name || "Homeowner"}</strong>
                      <span className="lead-address">
                        {lead.address.split(",")[0] || "No address"}
                      </span>
                      <span className="lead-tags">
                        {lead.followUpRequestedAt && (
                          <span className="lead-tag asked">
                            <CalendarCheck size={11} />
                            Asked for follow-up
                          </span>
                        )}
                        {lead.contactPermission === false &&
                          !lead.followUpRequestedAt && (
                            <span className="lead-tag no-contact">
                              <ShieldAlert size={11} />
                              No contact permission
                            </span>
                          )}
                        {lead.change && (
                          <span className="lead-tag">
                            {CHANGE_LABELS[lead.change] || lead.change}
                          </span>
                        )}
                      </span>
                      <span className="lead-meta">
                        {ago(lead.followUpRequestedAt || lead.createdAt)}
                        {admin && lead.owner && (
                          <span className="lead-owner">
                            <UserRound size={11} />
                            {lead.owner.split("@")[0]}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  {!cards.length && (
                    <p className="lead-empty">
                      {column === "pool" ? "Nothing waiting" : "No leads"}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {open && (
        <LeadPanel
          key={open.id}
          lead={open}
          team={team}
          onSave={(change) => save(open, change)}
          onClose={() => setOpenId(null)}
          onOpenProperty={(id) => {
            setOpenId(null);
            onOpenProperty(id);
          }}
        />
      )}
    </section>
  );
}

function LeadPanel({
  lead,
  team,
  onSave,
  onClose,
  onOpenProperty,
}: {
  lead: Lead;
  team: string[];
  onSave: (
    change: Partial<Pick<Lead, "stage" | "notes" | "owner">>,
  ) => Promise<boolean>;
  onClose: () => void;
  onOpenProperty: (id: string) => void;
}) {
  const account = useAccount(),
    admin = account.role === "admin",
    mine = Boolean(lead.owner) && lead.owner === account.email;
  const [notes, setNotes] = useState(lead.notes),
    [busy, setBusy] = useState(false),
    [viewing, setViewing] = useState<number | null>(null);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape" && viewing === null) onClose();
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [onClose, viewing]);
  async function run(change: Partial<Pick<Lead, "stage" | "notes" | "owner">>) {
    setBusy(true);
    await onSave(change);
    setBusy(false);
  }
  // The website's photo of the house and the design made from it.
  const pictures: PropertyPhoto[] = [
    lead.photoUrl && { id: "photo", url: lead.photoUrl },
    lead.designUrl && { id: "design", url: lead.designUrl },
  ]
    .filter((p): p is { id: string; url: string } => Boolean(p))
    .map((p) => ({
      ...p,
      propertyId: lead.propertyId || "",
      publicId: p.id,
      width: null,
      height: null,
      createdAt: lead.createdAt,
    }));
  const canWork = admin || mine || !lead.owner;
  return (
    <aside className="detail-panel lead-panel" aria-label="Lead details">
      <div className="detail-top">
        <span className="eyebrow">WEBSITE LEAD</span>
        <button
          className="icon-button"
          aria-label="Close lead details"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="detail-scroll">
        <div className="property-heading">
          <div className="parcel-icon">
            <UserRound size={27} strokeWidth={1.5} />
          </div>
          <h2>{lead.name || "Homeowner"}</h2>
          <p>{lead.address || "No address given"}</p>
          <span className="micro">
            LEFT ON THE WEBSITE {eventTime(lead.createdAt).toUpperCase()}
          </span>
          <div className="detail-links">
            <a className="primary-button" href={`tel:${lead.phone}`}>
              <Phone size={15} />
              {phoneLabel(lead.phone)}
            </a>
            <a className="secondary-button" href={`sms:${lead.phone}`}>
              <MessageSquare size={15} />
              Text
            </a>
            {lead.address && (
              <a
                className="secondary-button"
                href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lead.address)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Navigation size={15} />
                Navigate
              </a>
            )}
          </div>
        </div>
        <div className="lead-consent">
          {lead.followUpRequestedAt ? (
            <p className="consent ok">
              <CalendarCheck size={16} />
              Asked for a specialist to follow up,{" "}
              {eventTime(lead.followUpRequestedAt)}.
            </p>
          ) : null}
          {lead.contactPermission === true ? (
            <p className="consent ok">
              <ShieldCheck size={16} />
              Ticked “OK to contact me” on the website.
            </p>
          ) : lead.contactPermission === false ? (
            <p className="consent warn">
              <ShieldAlert size={16} />
              Did not tick “OK to contact me” on the website.
            </p>
          ) : (
            <p className="consent unknown">
              <ShieldAlert size={16} />
              The website did not say whether they agreed to be contacted.
            </p>
          )}
        </div>
        <div className="section-title">
          <h3>Pipeline</h3>
          <span>
            {lead.owner ? (mine ? "Yours" : lead.owner) : "Unassigned"}
          </span>
        </div>
        <div className="lead-controls">
          <label>
            Stage
            <select
              value={lead.stage}
              disabled={busy || !canWork}
              onChange={(e) => {
                const stage = e.target.value as LeadStage;
                void run(
                  !lead.owner && account.email
                    ? { stage, owner: account.email }
                    : { stage },
                );
              }}
            >
              {LEAD_STAGES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          {admin ? (
            <label>
              Assigned to
              <select
                value={lead.owner || ""}
                disabled={busy}
                onChange={(e) => void run({ owner: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {team.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
            </label>
          ) : !lead.owner ? (
            <button
              className="primary-button"
              disabled={busy || !account.email}
              onClick={() => void run({ owner: account.email })}
            >
              Take this lead
            </button>
          ) : mine ? (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void run({ owner: null })}
            >
              Hand back to Unassigned
            </button>
          ) : null}
        </div>
        {(lead.change || lead.collection) && (
          <>
            <div className="section-title">
              <h3>Interested in</h3>
            </div>
            <p className="lead-interest">
              {[
                lead.change && (CHANGE_LABELS[lead.change] || lead.change),
                lead.collection && `${lead.collection} collection`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        )}
        {pictures.length > 0 && (
          <>
            <div className="section-title">
              <h3>From the studio</h3>
              <span>
                {pictures.length === 2 ? "Photo and design" : "1 image"}
              </span>
            </div>
            <div className="photo-grid lead-pictures">
              {pictures.map((picture, i) => (
                <figure key={picture.id}>
                  <button
                    className="photo-open"
                    aria-label={`View ${picture.id === "design" ? "the design" : "the photo"}`}
                    onClick={() => setViewing(i)}
                  >
                    <img
                      src={picture.url}
                      alt={picture.id === "design" ? "Design" : "House photo"}
                      loading="lazy"
                    />
                  </button>
                  <figcaption>
                    {picture.id === "design" ? "Design" : "Photo"}
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
        {lead.propertyId && (
          <button
            className="secondary-button full lead-property"
            onClick={() => onOpenProperty(lead.propertyId!)}
          >
            Open the county parcel
            <ArrowUpRight size={15} />
          </button>
        )}
        <div className="section-title">
          <h3>Notes</h3>
        </div>
        <form
          className="lead-notes"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ notes });
          }}
        >
          <label className="sr-only" htmlFor={`notes-${lead.id}`}>
            Notes
          </label>
          <textarea
            id={`notes-${lead.id}`}
            rows={4}
            maxLength={5000}
            value={notes}
            disabled={!canWork}
            placeholder="What happened, what's next"
            onChange={(e) => setNotes(e.target.value)}
          />
          <button
            className="small-button"
            disabled={busy || !canWork || notes.trim() === lead.notes}
          >
            Save notes
          </button>
        </form>
      </div>
      {viewing !== null && (
        <PhotoViewer
          photos={pictures}
          start={viewing}
          label={`${lead.name || "Homeowner"}, ${lead.address}`}
          onClose={() => setViewing(null)}
        />
      )}
    </aside>
  );
}
