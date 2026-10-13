import { useEffect, useState } from "react";
import { Briefcase, ExternalLink, RotateCcw, Save } from "lucide-react";
import type { CareersSettings } from "../shared/types";
import { api } from "./api";
import { eventTime } from "./DetailPanel";
import ConfirmDialog from "./ConfirmDialog";
import { LogoSpinner } from "./Logo";

type Draft = Omit<CareersSettings, "updatedAt" | "work" | "fit"> & {
  // Edited as text, one item per line.
  work: string;
  fit: string;
};
const toDraft = (c: CareersSettings): Draft => ({
  open: c.open,
  jobTitle: c.jobTitle,
  title: c.title,
  lede: c.lede,
  work: c.work.join("\n"),
  fit: c.fit.join("\n"),
  note: c.note,
});
const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const fromDraft = (d: Draft) => ({
  open: d.open,
  jobTitle: d.jobTitle.trim(),
  title: d.title.trim(),
  lede: d.lede.trim(),
  work: lines(d.work),
  fit: lines(d.fit),
  note: d.note.trim(),
});
const same = (a: Draft, b: Draft) =>
  JSON.stringify(fromDraft(a)) === JSON.stringify(fromDraft(b));

// Settings that live on the website, changed from here: for now the careers
// page, which can be opened or closed and whose text can be edited.
export default function SettingsView() {
  const [saved, setSaved] = useState<CareersSettings | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [website, setWebsite] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState<"load" | "save" | "switch" | null>("load"),
    [confirm, setConfirm] = useState<"open" | "close" | null>(null),
    [notice, setNotice] = useState("");
  function load() {
    setBusy("load");
    setError("");
    api<{ careers: CareersSettings; website: string }>("/admin/website/careers")
      .then((d) => {
        setSaved(d.careers);
        setDraft(toDraft(d.careers));
        setWebsite(d.website);
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(null));
  }
  useEffect(load, []);
  async function save(
    next: ReturnType<typeof fromDraft>,
    kind: "save" | "switch",
  ) {
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const d = await api<{ careers: CareersSettings }>(
        "/admin/website/careers",
        { method: "PUT", body: JSON.stringify(next) },
      );
      setSaved(d.careers);
      // Opening or closing keeps any text being edited.
      setDraft((current) =>
        kind === "switch" && current
          ? { ...current, open: d.careers.open }
          : toDraft(d.careers),
      );
      setNotice(
        kind === "switch"
          ? d.careers.open
            ? "The careers page is open. The website shows it within a few seconds."
            : "The careers page is closed. The website stops showing it within a few seconds."
          : "Saved. The website shows the new text within a few seconds.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  const dirty = Boolean(saved && draft && !same(draft, toDraft(saved)));
  const careersUrl = `${website}/careers`;
  return (
    <section className="content-section settings-section">
      <div className="settings-card">
        <div className="settings-head">
          <span className="leads-intro-icon">
            <Briefcase size={22} strokeWidth={1.6} />
          </span>
          <div>
            <h2>Careers page</h2>
            <p className="muted small">
              The hiring page on the website, with its application form.
              {saved?.updatedAt
                ? ` Last changed ${eventTime(new Date(saved.updatedAt).toISOString())}.`
                : ""}
            </p>
          </div>
          {saved && (
            <label className="switch settings-switch">
              <input
                type="checkbox"
                checked={saved.open}
                disabled={busy !== null}
                onChange={() => setConfirm(saved.open ? "close" : "open")}
              />
              <span aria-hidden="true" />
              <span className="settings-switch-label">
                {busy === "switch" ? "Saving…" : saved.open ? "Open" : "Closed"}
              </span>
            </label>
          )}
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}{" "}
            {!saved && (
              <button className="text-link" onClick={load}>
                Try again
              </button>
            )}
          </div>
        )}
        {notice && !error && (
          <p className="settings-notice" role="status">
            {notice}
            {saved?.open && (
              <>
                {" "}
                <a href={careersUrl} target="_blank" rel="noreferrer">
                  View the page
                  <ExternalLink size={12} />
                </a>
              </>
            )}
          </p>
        )}
        {busy === "load" && !saved && (
          <p className="settings-loading" role="status">
            <LogoSpinner />
            Asking the website for its settings. If it was asleep, this can take
            up to a minute.
          </p>
        )}
        {draft && saved && (
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save({ ...fromDraft(draft), open: saved.open }, "save");
            }}
          >
            <div className="settings-grid">
              <label>
                Role
                <input
                  required
                  minLength={3}
                  maxLength={80}
                  value={draft.jobTitle}
                  onChange={(e) => set("jobTitle", e.target.value)}
                />
                <span className="help">
                  Used in the browser tab, search results and the job posting.
                </span>
              </label>
              <label>
                Heading
                <input
                  required
                  minLength={3}
                  maxLength={160}
                  value={draft.title}
                  onChange={(e) => set("title", e.target.value)}
                />
              </label>
              <label className="wide">
                Introduction
                <textarea
                  required
                  minLength={10}
                  maxLength={600}
                  rows={3}
                  value={draft.lede}
                  onChange={(e) => set("lede", e.target.value)}
                />
              </label>
              <label>
                The work
                <textarea
                  required
                  rows={6}
                  value={draft.work}
                  onChange={(e) => set("work", e.target.value)}
                />
                <span className="help">
                  One point per line, up to 10. {lines(draft.work).length} now.
                </span>
              </label>
              <label>
                Who does well here
                <textarea
                  required
                  rows={6}
                  value={draft.fit}
                  onChange={(e) => set("fit", e.target.value)}
                />
                <span className="help">
                  One point per line, up to 10. {lines(draft.fit).length} now.
                </span>
              </label>
              <label className="wide">
                Small print
                <input
                  maxLength={300}
                  value={draft.note}
                  onChange={(e) => set("note", e.target.value)}
                />
                <span className="help">
                  Shown under the second list. Leave empty to hide it.
                </span>
              </label>
            </div>
            <div className="settings-actions">
              {saved.open && (
                <a
                  className="text-link"
                  href={careersUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View the careers page
                  <ExternalLink size={13} />
                </a>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={!dirty || busy !== null}
                onClick={() => setDraft(toDraft(saved))}
              >
                <RotateCcw size={15} />
                Discard
              </button>
              <button
                className={`primary-button ${busy === "save" ? "is-busy" : ""}`}
                disabled={!dirty || busy !== null}
              >
                {busy === "save" ? <LogoSpinner /> : <Save size={15} />}
                {busy === "save" ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </div>
      {confirm && saved && (
        <ConfirmDialog
          title={
            confirm === "open"
              ? "Open the careers page?"
              : "Close the careers page?"
          }
          message={
            confirm === "open"
              ? "Anyone can see it and apply. The careers link appears in the website's menu and footer."
              : "The page and its form stop working, and the links to it disappear. Applications already received are kept."
          }
          confirmLabel={confirm === "open" ? "Open the page" : "Close the page"}
          busyLabel="Saving…"
          tone={confirm === "open" ? "primary" : "danger"}
          busy={busy === "switch"}
          onConfirm={() =>
            void save(
              {
                ...fromDraft(toDraft(saved)),
                open: confirm === "open",
              },
              "switch",
            ).then(() => setConfirm(null))
          }
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
