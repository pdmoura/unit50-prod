import { useEffect, useState } from "react";
import { ShieldCheck, Trash2, UserPlus } from "lucide-react";
import {
  MODULES,
  MODULE_LABELS,
  type Module,
  type Role,
  type TeamMember,
} from "../shared/types";
import { api, post, patch, del } from "./api";
import { useAccount } from "./AuthGate";
import ConfirmDialog from "./ConfirmDialog";

// Who can sign in, and which modules each rep uses. Admins always have every
// module. Changes save at once and apply on the person's next click.
export default function AdminView() {
  const account = useAccount();
  const [members, setMembers] = useState<TeamMember[]>([]),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<Role>("rep"),
    [busy, setBusy] = useState<string | null>(null),
    [removing, setRemoving] = useState<TeamMember | null>(null);
  useEffect(() => {
    let live = true;
    api<{ items: TeamMember[] }>("/admin/users")
      .then((d) => {
        if (!live) return;
        setMembers(d.items);
        setLoaded(true);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  // Every change answers with the whole team, so the table always shows what is saved.
  async function act(key: string, request: () => Promise<unknown>) {
    setBusy(key);
    setError("");
    try {
      const d = (await request()) as { items: TeamMember[] };
      setMembers(d.items);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }
  const path = (m: TeamMember) => `/admin/users/${encodeURIComponent(m.email)}`;
  function toggle(m: TeamMember, module: Module) {
    const modules = m.modules.includes(module)
      ? m.modules.filter((x) => x !== module)
      : MODULES.filter((x) => x === module || m.modules.includes(x));
    void act(m.email, () => patch(path(m), { modules }));
  }
  return (
    <section className="content-section admin-section">
      <form
        className="team-add"
        onSubmit={(e) => {
          e.preventDefault();
          void act("add", () => post("/admin/users", { email, role })).then(
            (ok) => {
              if (ok) {
                setEmail("");
                setRole("rep");
              }
            },
          );
        }}
      >
        <div>
          <h2>Add someone to the team</h2>
          <p className="muted small">
            They sign in with a Supabase login: create it in the Supabase
            dashboard under Authentication → Users → Add user, with “Auto
            Confirm User” ticked.
          </p>
        </div>
        <div className="team-add-fields">
          <label>
            Email
            <input
              type="email"
              required
              autoComplete="off"
              value={email}
              placeholder="name@unit50.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Role
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
            >
              <option value="rep">Rep</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="primary-button" disabled={busy === "add"}>
            <UserPlus size={16} />
            {busy === "add" ? "Adding…" : "Add"}
          </button>
        </div>
      </form>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="section-title team-title">
        <h3>Access by module</h3>
        <span>
          {members.length} {members.length === 1 ? "person" : "people"}
        </span>
      </div>
      {loaded && (
        <div className="team-table" role="table" aria-label="Team access">
          <div className="team-row team-head" role="row">
            <span role="columnheader">Person</span>
            <span role="columnheader">Role</span>
            {MODULES.map((m) => (
              <span role="columnheader" key={m}>
                {MODULE_LABELS[m]}
              </span>
            ))}
            <span role="columnheader">
              <span className="sr-only">Remove</span>
            </span>
          </div>
          {members.map((m) => {
            const me = m.email === account.email,
              isAdmin = m.role === "admin";
            return (
              <div
                className={`team-row ${busy === m.email ? "saving" : ""}`}
                role="row"
                key={m.email}
              >
                <span role="cell" className="team-person">
                  <span className="workspace-avatar">
                    {m.email[0].toUpperCase()}
                  </span>
                  <span>
                    <strong title={m.email}>{m.email}</strong>
                    {me && <span className="micro">YOU</span>}
                  </span>
                </span>
                <span role="cell" className="team-role">
                  <label className="sr-only" htmlFor={`role-${m.email}`}>
                    Role of {m.email}
                  </label>
                  <select
                    id={`role-${m.email}`}
                    value={m.role}
                    disabled={me || busy === m.email}
                    title={
                      me ? "Another admin can change your role." : undefined
                    }
                    onChange={(e) =>
                      void act(m.email, () =>
                        patch(path(m), { role: e.target.value }),
                      )
                    }
                  >
                    <option value="rep">Rep</option>
                    <option value="admin">Admin</option>
                  </select>
                </span>
                {MODULES.map((module) => (
                  <span role="cell" className="team-module" key={module}>
                    <label
                      className="switch"
                      title={isAdmin ? "Admins use every module." : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={isAdmin || m.modules.includes(module)}
                        disabled={isAdmin || busy === m.email}
                        onChange={() => toggle(m, module)}
                      />
                      <span aria-hidden="true" />
                      <span className="switch-label">
                        {MODULE_LABELS[module]}
                      </span>
                    </label>
                  </span>
                ))}
                <span role="cell" className="team-remove">
                  {!me && (
                    <button
                      className="icon-button"
                      aria-label={`Remove ${m.email}`}
                      title="Remove from the team"
                      disabled={busy === m.email}
                      onClick={() => setRemoving(m)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="muted small team-note">
        <ShieldCheck size={14} />
        Admins have every module and this panel. A rep sees their own follow-ups
        and leads, plus the leads waiting in Unassigned.
      </p>
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.email}?`}
          message="They can no longer use Unit 50. Their leads go back to Unassigned; their visits and follow-ups stay on record."
          confirmLabel="Remove"
          busyLabel="Removing…"
          busy={busy === removing.email}
          onConfirm={() =>
            void act(removing.email, () => del(path(removing))).then(() =>
              setRemoving(null),
            )
          }
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
