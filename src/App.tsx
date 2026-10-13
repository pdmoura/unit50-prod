import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Map,
  CalendarDays,
  Database,
  ArrowUpRight,
  ArrowRight,
  Search,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  MapPin,
  House,
  CheckCheck,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  Compass,
  X,
  PanelLeftClose,
  LogOut,
  ChevronsUpDown,
  SquareKanban,
  ShieldCheck,
} from "lucide-react";
import type {
  Filters,
  PropertyPage,
  PropertyDetail,
  Summary,
  FollowUp,
  ImportRun,
  DetailsCoverage,
} from "../shared/types";
import { PRIORITIES, STATUSES, utahToday } from "../shared/types";
import { api, query, post } from "./api";
import MapView from "./MapView";
import DetailPanel, { Badge, TaskRow, eventTime } from "./DetailPanel";
import { useAccount } from "./AuthGate";
import { LogoFull, LogoMark } from "./Logo";
import ConfirmDialog from "./ConfirmDialog";
import LeadsView from "./LeadsView";
import AdminView from "./AdminView";
const format = new Intl.NumberFormat("en-US");
type View = "map" | "follow-ups" | "leads" | "data" | "admin";
// The pages in the sidebar, in order. Each module an admin can turn on or off
// is one page; the admin panel is there for admins only.
const PAGES: {
  view: View;
  label: string;
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  text: string;
}[] = [
  {
    view: "map",
    label: "Prospecting map",
    icon: <Map size={20} />,
    eyebrow: "MAKE EVERY DOOR COUNT",
    title: "Your next opportunity, mapped.",
    text: "Discover homes, plan your outreach, and build lasting connections.",
  },
  {
    view: "follow-ups",
    label: "Follow-ups",
    icon: <CalendarDays size={20} />,
    eyebrow: "KEEP THE CONVERSATION GOING",
    title: "A little follow-through goes far.",
    text: "The right conversation, at the right time. All your next steps in one place.",
  },
  {
    view: "leads",
    label: "Leads",
    icon: <SquareKanban size={20} />,
    eyebrow: "FROM THE WEBSITE TO THE DOOR",
    title: "Every lead, one clear next step.",
    text: "Homeowners who designed their exterior on the website, ready for a conversation.",
  },
  {
    view: "data",
    label: "Data & imports",
    icon: <Database size={20} />,
    eyebrow: "A RELIABLE STARTING POINT",
    title: "Good data. Better direction.",
    text: "Real county records, with clear origins and a careful refresh.",
  },
  {
    view: "admin",
    label: "Team & access",
    icon: <ShieldCheck size={20} />,
    eyebrow: "THE RIGHT TOOLS FOR EVERY REP",
    title: "Your team, your rules.",
    text: "Choose who can sign in and which parts of Unit 50 each person uses.",
  },
];
const emptySummary: Summary = {
  total: 0,
  high: 0,
  visited: 0,
  due: 0,
  mapped: 0,
  cities: [],
  latest: null,
  today: utahToday(),
  photosEnabled: false,
};
export default function App() {
  const account = useAccount();
  // The pages this person may open; the server enforces the same rules.
  const pages = useMemo(
    () =>
      PAGES.filter((p) =>
        p.view === "admin"
          ? account.role === "admin"
          : account.modules.includes(p.view),
      ),
    [account.role, account.modules],
  );
  const pick = useCallback(
    (wanted: string) =>
      (pages.find((p) => p.view === wanted) || pages[0])?.view ?? null,
    [pages],
  );
  const [view, setView] = useState<View | null>(() =>
      pick(location.hash.slice(1)),
    ),
    [summary, setSummary] = useState<Summary>(emptySummary),
    [version, setVersion] = useState(0),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const [filters, setFilters] = useState<Filters>({}),
    [search, setSearch] = useState(""),
    [bbox, setBbox] = useState(""),
    [limitArea, setLimitArea] = useState(false),
    [page, setPage] = useState(1),
    [list, setList] = useState<PropertyPage>({
      items: [],
      total: 0,
      page: 1,
      pageSize: 40,
    }),
    [loading, setLoading] = useState(false),
    // Sign-out is confirmed first: "asking" shows the dialog, "leaving" waits.
    [leaving, setLeaving] = useState<"asking" | "leaving" | null>(null),
    [accountMenu, setAccountMenu] = useState(false),
    [selected, setSelected] = useState<PropertyDetail | null>(null),
    [detailLoading, setDetailLoading] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  // The account menu closes on a click or tap anywhere else, and on Escape.
  useEffect(() => {
    if (!accountMenu) return;
    const outside = (e: PointerEvent) => {
      if (!accountRef.current?.contains(e.target as Node))
        setAccountMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountMenu(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", onKey);
    };
  }, [accountMenu]);
  const detailRequest = useRef(0),
    selectedId = useRef<string | null>(null);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const cb = () => {
      const next = pick(location.hash.slice(1));
      setView(next);
      // A page this person cannot open: the address shows where they landed.
      if (next && location.hash.slice(1) !== next)
        history.replaceState(null, "", `#${next}`);
    };
    cb();
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, [pick]);
  const current = PAGES.find((p) => p.view === view);
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, q: search }));
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    let live = true;
    api<Summary>("/summary")
      .then((s) => {
        if (live) {
          setSummary(s);
          setReady(true);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [version]);
  useEffect(() => {
    if (summary.latest?.state !== "running") return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [summary.latest?.state, refresh]);
  const effective = useMemo(
    () => ({ ...filters, ...(limitArea && bbox ? { bbox } : {}) }),
    [filters, limitArea, bbox],
  );
  useEffect(() => setPage(1), [effective]);
  useEffect(() => {
    if (view !== "map") return;
    const c = new AbortController();
    setLoading(true);
    api<PropertyPage>(`/properties?${query({ ...effective, page })}`, {
      signal: c.signal,
    })
      .then((d) => {
        setList(d);
        setLoading(false);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => c.abort();
  }, [effective, page, version, view]);
  const select = useCallback(async (id: string) => {
    const seq = ++detailRequest.current;
    selectedId.current = id;
    setDetailLoading(true);
    try {
      const p = await api<PropertyDetail>(
        `/properties/${encodeURIComponent(id)}`,
      );
      if (seq === detailRequest.current) setSelected(p);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (seq === detailRequest.current) setDetailLoading(false);
    }
  }, []);
  const close = useCallback(() => {
    detailRequest.current++;
    selectedId.current = null;
    setSelected(null);
    setDetailLoading(false);
  }, []);
  const changed = useCallback(() => {
    refresh();
    if (selectedId.current) void select(selectedId.current);
  }, [refresh, select]);
  function filter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }
  function navigate(wanted: View) {
    const next = pick(wanted);
    if (!next) return;
    location.hash = next;
    setView(next);
    close();
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href={`#${pages[0]?.view ?? ""}`}
          onClick={() => pages[0] && navigate(pages[0].view)}
          aria-label="Unit 50 home"
        >
          <LogoFull className="brand-full" />
          <LogoMark className="brand-mark" />
        </a>
        <div className="sidebar-section">WORKSPACE</div>
        <nav>
          {pages.map((p) => (
            <a
              key={p.view}
              href={`#${p.view}`}
              className={view === p.view ? "active" : ""}
              title={p.label}
              onClick={() => navigate(p.view)}
            >
              {p.icon}
              {p.label}
              {p.view === "map" && (
                <ArrowUpRight size={15} className="nav-end" />
              )}
              {p.view === "follow-ups" && summary.due > 0 && (
                <span className="nav-count">{summary.due}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="territory-card">
          <span className="eyebrow">YOUR TERRITORY</span>
          <div className="terrain-art">
            <svg viewBox="0 0 180 90" aria-hidden="true">
              <path
                d="M0 83 32 49 48 64 90 13 120 51 137 32 180 81M0 89 48 71 90 30 120 68 145 49 180 88M25 90 90 45 122 82 151 68 180 89"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
              <circle cx="91" cy="14" r="4" fill="#c4db9d" />
            </svg>
          </div>
          <strong>Weber County</strong>
          <span>Utah, United States</span>
          <div className="territory-footer">
            <i className="live-dot" />
            Single-family residential
          </div>
        </div>
        {account.signOut ? (
          <div className="sidebar-account" ref={accountRef}>
            {accountMenu && (
              <div className="account-menu" role="menu">
                <button
                  role="menuitem"
                  autoFocus
                  onClick={() => {
                    setAccountMenu(false);
                    setLeaving("asking");
                  }}
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </div>
            )}
            <button
              className="sidebar-bottom"
              aria-haspopup="menu"
              aria-expanded={accountMenu}
              title={account.email || undefined}
              onClick={() => setAccountMenu((open) => !open)}
            >
              <span className="workspace-avatar">
                {(account.email || "U")[0].toUpperCase()}
              </span>
              <span className="who">
                <strong>Signed in</strong>
                <span>{account.email}</span>
              </span>
              <ChevronsUpDown size={15} className="account-chevron" />
            </button>
          </div>
        ) : (
          <div className="sidebar-account">
            <div className="sidebar-bottom">
              <span className="workspace-avatar">U</span>
              <span className="who">
                <strong>Local workspace</strong>
                <span>Saved on this computer</span>
              </span>
              <span className="connection-dot" />
            </div>
          </div>
        )}
        {account.signOut && (
          <button
            className="sidebar-signout"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => setLeaving("asking")}
          >
            <LogOut size={21} />
          </button>
        )}
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="slash">/</span>
            <span>{current?.label ?? "No access"}</span>
          </div>
          {!account.signOut && (
            <span className="local-pill">
              <i className="live-dot" />
              LOCAL MVP
            </span>
          )}
        </header>
        <div className="page-heading">
          <div>
            <span className="eyebrow">{current?.eyebrow ?? "ACCESS"}</span>
            <h1>{current?.title ?? "Nothing is turned on yet."}</h1>
            <p>
              {current?.text ??
                "Your account has no modules turned on. Ask an admin to give you access."}
            </p>
          </div>
          {view === "map" && pages.some((p) => p.view === "follow-ups") && (
            <button
              className="secondary-button header-action"
              onClick={() => navigate("follow-ups")}
            >
              <CalendarDays size={17} />
              Today’s follow-ups
              <ArrowRight size={16} />
            </button>
          )}
        </div>
        {error && (
          <div className="global-error" role="alert">
            <AlertCircle size={17} />
            {error}
            <button className="text-link" onClick={refresh}>
              Retry
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {view === "map" ? (
          <>
            <div className="stats-strip">
              <Stat
                label="RESIDENTIAL PROPERTIES"
                value={summary.total}
                icon={<House size={19} />}
                note="Unique county parcels"
              />
              <Stat
                label="HIGH PRIORITY"
                value={summary.high}
                icon={<Compass size={19} />}
                note="Estimated age of 40+ years"
              />
              <Stat
                label="PROPERTIES VISITED"
                value={summary.visited}
                icon={<CheckCheck size={19} />}
                note="Your progress on the ground"
              />
              <Stat
                label="FOLLOW-UPS DUE"
                value={summary.due}
                icon={<CalendarDays size={19} />}
                note="Today and overdue"
              />
            </div>
            <div className="map-workspace">
              <div className="filters">
                <div className="search-field">
                  <Search size={17} />
                  <input
                    aria-label="Search address or parcel"
                    placeholder="Search address, owner or parcel ID"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search && (
                    <button
                      className="icon-button"
                      aria-label="Clear search"
                      onClick={() => setSearch("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <select
                  aria-label="Filter city"
                  value={filters.city || ""}
                  onChange={(e) => filter("city", e.target.value)}
                >
                  <option value="">All cities</option>
                  {summary.cities.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
                <select
                  aria-label="Filter priority"
                  value={filters.priority || ""}
                  onChange={(e) =>
                    filter("priority", e.target.value as Filters["priority"])
                  }
                >
                  <option value="">All priorities</option>
                  {PRIORITIES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
                <select
                  aria-label="Filter status"
                  value={filters.status || ""}
                  onChange={(e) =>
                    filter("status", e.target.value as Filters["status"])
                  }
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
                <div className="age-filter">
                  <SlidersHorizontal size={16} />
                  <input
                    type="number"
                    min="0"
                    max="500"
                    aria-label="Minimum age"
                    placeholder="Min age"
                    value={filters.minAge || ""}
                    onChange={(e) => filter("minAge", e.target.value)}
                  />
                  <span>–</span>
                  <input
                    type="number"
                    min="0"
                    max="500"
                    aria-label="Maximum age"
                    placeholder="Max"
                    value={filters.maxAge || ""}
                    onChange={(e) => filter("maxAge", e.target.value)}
                  />
                </div>
                {Object.values(filters).some(Boolean) && (
                  <button
                    className="text-link reset-filters"
                    onClick={() => {
                      setSearch("");
                      setFilters({});
                      setPage(1);
                    }}
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="map-content">
                <section
                  className="property-list"
                  aria-label="Property results"
                >
                  <div className="list-heading">
                    <div>
                      <strong>{format.format(list.total)} properties</strong>
                      <span>
                        <i className="dot high" />
                        Oldest homes first
                      </span>
                    </div>
                    <label className="area-toggle">
                      <input
                        type="checkbox"
                        checked={limitArea}
                        onChange={(e) => setLimitArea(e.target.checked)}
                      />
                      Search this map area
                    </label>
                  </div>
                  <div
                    className={`property-results ${loading ? "is-loading" : ""}`}
                    aria-busy={loading}
                  >
                    {list.items.map((p) => (
                      <button
                        className={`property-card ${selected?.id === p.id ? "selected" : ""}`}
                        key={p.id}
                        onClick={() => void select(p.id)}
                      >
                        <div className="property-card-top">
                          <span className="tiny-house">
                            <House size={18} />
                          </span>
                          <Badge value={p.priority} />
                        </div>
                        <strong>{p.address || "Address unavailable"}</strong>
                        <span className="card-city">
                          {p.city || "City unavailable"}
                          {p.zip ? `, UT ${p.zip}` : ""}
                        </span>
                        <div className="card-facts">
                          <span>
                            {p.year
                              ? `Built ${Number.isInteger(p.year) ? p.year : p.year.toFixed(1)}*`
                              : "Year unknown"}
                          </span>
                          <i />
                          <span>
                            {p.sqft !== null
                              ? `${format.format(p.sqft)} sq ft`
                              : "Area unknown"}
                          </span>
                        </div>
                        <div className="card-footer">
                          <span
                            className={`status-text ${p.status === "Interested" ? "interested" : ""}`}
                          >
                            <i />
                            {p.status}
                          </span>
                          {p.nextFollowUp ? (
                            <span className="next-return">
                              <CalendarDays size={12} />
                              {p.nextFollowUp.slice(5)}
                            </span>
                          ) : (
                            <ArrowUpRight size={15} />
                          )}
                        </div>
                      </button>
                    ))}
                    {!list.items.length && !loading && (
                      <div className="empty-state">
                        <Search size={30} />
                        <h3>
                          {summary.total
                            ? "No matching homes"
                            : "Your territory is waiting"}
                        </h3>
                        <p>
                          {summary.total
                            ? "Try a different address or broaden your filters."
                            : "Import Weber County records to find your first opportunity."}
                        </p>
                        <button
                          className="secondary-button"
                          onClick={() =>
                            summary.total
                              ? (setFilters({}),
                                setSearch(""),
                                setLimitArea(false))
                              : navigate("data")
                          }
                        >
                          {summary.total
                            ? "Clear filters"
                            : "Import county data"}
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="pagination">
                    <span>
                      {list.total
                        ? `${(page - 1) * list.pageSize + 1}–${Math.min(page * list.pageSize, list.total)}`
                        : "0"}{" "}
                      of {format.format(list.total)}
                    </span>
                    <div>
                      <button
                        aria-label="Previous page"
                        className="icon-button"
                        disabled={page === 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        <ChevronLeft size={17} />
                      </button>
                      <button
                        aria-label="Next page"
                        className="icon-button"
                        disabled={page * list.pageSize >= list.total}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        <ChevronRight size={17} />
                      </button>
                    </div>
                  </div>
                </section>
                <MapView
                  filters={filters}
                  version={version}
                  selected={selected}
                  onSelect={select}
                  onBounds={setBbox}
                />
              </div>
              <footer className="map-footer">
                <span>
                  <i className="live-dot" />
                  Weber County public records
                </span>
                <span>Age-based priority · not a prediction of purchase</span>
              </footer>
            </div>
          </>
        ) : view === "follow-ups" ? (
          <FollowUpView
            version={version}
            onChange={changed}
            onOpen={select}
            team={account.role === "admin" && Boolean(account.email)}
          />
        ) : view === "leads" ? (
          <LeadsView version={version} onOpenProperty={select} />
        ) : view === "admin" ? (
          <AdminView />
        ) : view === "data" ? (
          <DataView
            summary={summary}
            version={version}
            onChange={refresh}
            onOpen={select}
          />
        ) : null}
        {!ready && !error && (
          <div className="loading-line" role="status">
            Connecting to your local workspace…
          </div>
        )}
      </main>
      {detailLoading && !selected && (
        <div className="detail-loading" role="status">
          Opening property…
        </div>
      )}
      {selected && (
        <DetailPanel
          key={selected.id}
          property={selected}
          photosEnabled={summary.photosEnabled}
          onClose={close}
          onChange={changed}
        />
      )}
      {leaving && account.signOut && (
        <ConfirmDialog
          title="Sign out of Unit 50?"
          message="You will need your email and password to sign in again on this device."
          confirmLabel="Sign out"
          busyLabel="Signing out…"
          tone="primary"
          busy={leaving === "leaving"}
          onConfirm={() => {
            setLeaving("leaving");
            account.signOut!();
          }}
          onCancel={() => setLeaving(null)}
        />
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  icon,
  note,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  note: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <strong>{format.format(value)}</strong>
      <span>{note}</span>
    </div>
  );
}
// A rep's own follow-ups. An admin (team) sees everyone's, with whose each one
// is, and can narrow it down to their own.
function FollowUpView({
  version,
  onChange,
  onOpen,
  team,
}: {
  version: number;
  onChange: () => void;
  onOpen: (id: string) => void;
  team: boolean;
}) {
  const [items, setItems] = useState<FollowUp[]>([]),
    [error, setError] = useState(""),
    [history, setHistory] = useState(false),
    [onlyMine, setOnlyMine] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ items: FollowUp[] }>(
      `/follow-ups${team && onlyMine ? "?who=me" : ""}`,
    )
      .then((d) => {
        if (live) {
          setItems(d.items);
          setError("");
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [version, team, onlyMine]);
  const today = utahToday(),
    groups = history
      ? [
          {
            name: "Completed & cancelled",
            items: items.filter((t) => t.state !== "pending"),
          },
        ]
      : [
          {
            name: "Overdue",
            items: items.filter(
              (t) => t.state === "pending" && t.dueDate < today,
            ),
          },
          {
            name: "Today",
            items: items.filter(
              (t) => t.state === "pending" && t.dueDate === today,
            ),
          },
          {
            name: "Upcoming",
            items: items.filter(
              (t) => t.state === "pending" && t.dueDate > today,
            ),
          },
        ];
  return (
    <section className="content-section">
      <div className="section-toolbar">
        <div className="segmented">
          <button
            className={!history ? "selected" : ""}
            onClick={() => setHistory(false)}
          >
            Pending{" "}
            <span>{items.filter((t) => t.state === "pending").length}</span>
          </button>
          <button
            className={history ? "selected" : ""}
            onClick={() => setHistory(true)}
          >
            History
          </button>
        </div>
        {team ? (
          <div className="segmented">
            <button
              className={!onlyMine ? "selected" : ""}
              onClick={() => setOnlyMine(false)}
            >
              Everyone
            </button>
            <button
              className={onlyMine ? "selected" : ""}
              onClick={() => setOnlyMine(true)}
            >
              Mine
            </button>
          </div>
        ) : (
          <span className="muted small">Calendar dates · Utah</span>
        )}
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
          <button className="text-link" onClick={onChange}>
            Retry
          </button>
        </div>
      )}
      {groups.every((g) => !g.items.length) ? (
        <div className="large-empty">
          <div className="empty-emblem">
            <CalendarDays size={38} strokeWidth={1.3} />
          </div>
          <span className="eyebrow">ROOM FOR YOUR NEXT CONVERSATION</span>
          <h2>
            {history ? "No completed follow-ups yet." : "You’re all caught up."}
          </h2>
          <p>
            Open a property on the map and schedule your next visit.
            <br />
            Your follow-ups will appear here.
          </p>
          <a className="primary-button" href="#map">
            Explore the map
            <ArrowRight size={17} />
          </a>
        </div>
      ) : (
        groups
          .filter((g) => g.items.length)
          .map((g) => (
            <section className="task-group" key={g.name}>
              <h3>
                {g.name}
                <span>{g.items.length}</span>
              </h3>
              {g.items.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  onChange={onChange}
                  onOpen={onOpen}
                  showOwner={team && !onlyMine}
                />
              ))}
            </section>
          ))
      )}
    </section>
  );
}
function CountyDetailsCard({ version }: { version: number }) {
  const [coverage, setCoverage] = useState<DetailsCoverage | null>(null),
    [tick, setTick] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const run = coverage?.latest,
    active = run?.state === "running" || run?.state === "stopping";
  useEffect(() => {
    let live = true;
    api<DetailsCoverage>("/county-details")
      .then((c) => live && setCoverage(c))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [version, tick]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [active]);
  async function act(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await post(path, body);
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!coverage) return null;
  const percent = coverage.active
      ? Math.floor((coverage.fetched / coverage.active) * 100)
      : 0,
    runPercent = run?.total ? Math.round((run.processed / run.total) * 100) : 0,
    missing = coverage.active - coverage.fetched;
  return (
    <div className="import-progress details-run" role="status">
      <div>
        <strong>
          Parcel Search details · buildings, loan company, charges
        </strong>
        <span>
          {format.format(coverage.fetched)} / {format.format(coverage.active)}{" "}
          parcels · {percent}%
          {coverage.errors ? ` · ${format.format(coverage.errors)} failed` : ""}
        </span>
      </div>
      <progress value={percent} max="100" />
      {run && (
        <p>
          {active
            ? `${run.message} ${format.format(run.processed)} / ${format.format(run.total)} this run · ${runPercent}%`
            : `Last run ${run.state} · ${eventTime(run.startedAt)} · ${run.message}`}
        </p>
      )}
      <p>
        Read one parcel at a time from webercountyutah.gov/parcelsearch (about a
        parcel per second). You can keep working; stopping keeps everything
        fetched so far.
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="actions">
        {active ? (
          <button
            className="secondary-button"
            disabled={busy || run?.state === "stopping"}
            onClick={() => void act(`/county-details/runs/${run!.id}/stop`, {})}
          >
            {run?.state === "stopping" ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <>
            <button
              className="primary-button"
              disabled={busy || missing <= 0}
              onClick={() =>
                void act("/county-details/runs", { mode: "missing" })
              }
            >
              <Download size={17} />
              {coverage.fetched
                ? "Fetch remaining parcels"
                : "Fetch details for every parcel"}
            </button>
            {coverage.fetched > 0 && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() =>
                  void act("/county-details/runs", { mode: "refresh" })
                }
              >
                <RefreshCw size={16} />
                Refresh details older than 30 days
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
function DataView({
  summary,
  version,
  onChange,
  onOpen,
}: {
  summary: Summary;
  version: number;
  onChange: () => void;
  onOpen: (id: string) => void;
}) {
  const [runs, setRuns] = useState<ImportRun[]>([]),
    [issues, setIssues] = useState<
      { id: string; address: string; issues: string[] }[]
    >([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ items: ImportRun[] }>("/imports"),
      api<{ items: typeof issues }>("/data/issues"),
    ])
      .then(([r, i]) => {
        if (live) {
          setRuns(r.items);
          setIssues(i.items);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [version]);
  const running = summary.latest?.state === "running",
    run = summary.latest,
    progress = run?.total ? Math.round((run.processed / run.total) * 100) : 0;
  async function start() {
    setBusy(true);
    setError("");
    try {
      await post("/imports", {});
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="content-section data-view">
      <div className="source-card">
        <div className="source-emblem">
          <Database size={29} strokeWidth={1.4} />
        </div>
        <div>
          <span className="eyebrow">CONNECTED DATA SOURCE</span>
          <h2>Weber County · Parcel Master</h2>
          <p>
            Single-family residential records, directly from the county’s public
            GIS service.
          </p>
          <a
            className="text-link"
            href="https://maps.webercountyutah.gov/arcgis/rest/services/gis/parcels_geogizmo2/MapServer/0"
            target="_blank"
            rel="noreferrer"
          >
            View source
            <ArrowUpRight size={14} />
          </a>
        </div>
        <button
          className="primary-button"
          disabled={busy || running}
          onClick={() => void start()}
        >
          {running ? (
            <RefreshCw size={17} className="spin" />
          ) : (
            <Download size={17} />
          )}
          {running
            ? "Importing…"
            : summary.total
              ? "Refresh county data"
              : "Import county data"}
        </button>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <CountyDetailsCard version={version} />
      {running && (
        <div className="import-progress" role="status">
          <div>
            <strong>{run?.message}</strong>
            <span>
              {format.format(run?.processed || 0)} /{" "}
              {format.format(run?.total || 0)} records · {progress}%
            </span>
          </div>
          <progress value={progress} max="100" />
          <p>
            The current dataset stays available until every batch has been
            validated.
          </p>
        </div>
      )}
      {run?.state === "failed" && (
        <div className="notice error-notice">
          <AlertCircle size={20} />
          <div>
            <strong>The last import did not finish</strong>
            <p>{run.message}</p>
            <p>
              The last complete dataset and your activities have been preserved.
              Use Refresh to retry.
            </p>
          </div>
        </div>
      )}
      <div className="data-metrics">
        <Stat
          label="ACTIVE PARCELS"
          value={summary.total}
          icon={<House size={18} />}
          note="Distinct parcel identifiers"
        />
        <Stat
          label="MAPPED PARCELS"
          value={summary.mapped}
          icon={<MapPin size={18} />}
          note="Valid representative position"
        />
        <Stat
          label="DATA NOTES"
          value={runs.find((r) => r.state === "completed")?.issues || 0}
          icon={<AlertCircle size={18} />}
          note="Parcels with missing or conflicting data"
        />
      </div>
      <div className="data-columns">
        <div className="data-info">
          <span className="eyebrow">HOW YOUR DATA WORKS</span>
          <h3>
            A fresh dataset.
            <br />
            The same conversation.
          </h3>
          <p>
            County attributes refresh independently of your visits, contact
            statuses, and follow-ups. Your work stays with the parcel.
          </p>
          <ul>
            <li>
              <CheckCircle2 size={16} />
              Validated before activation
            </li>
            <li>
              <CheckCircle2 size={16} />
              Original parcel identifiers preserved
            </li>
            <li>
              <CheckCircle2 size={16} />
              Conflicting records marked Unknown
            </li>
            <li>
              <CheckCircle2 size={16} />
              Saved locally on this computer
            </li>
          </ul>
          <div className="notice">
            <AlertCircle size={17} />
            <p>
              A parcel can contain multiple county geometries. Source records
              and unique properties may have different totals.
            </p>
          </div>
        </div>
        <div className="import-history">
          <div className="section-title">
            <h3>Import history</h3>
            <span>Last 15 runs</span>
          </div>
          {!runs.length ? (
            <p className="muted">Your first import will appear here.</p>
          ) : (
            runs.map((r) => (
              <div className="import-row" key={r.id}>
                <span className={`import-state ${r.state}`}>
                  {r.state === "completed" ? (
                    <CheckCircle2 size={18} />
                  ) : r.state === "failed" ? (
                    <AlertCircle size={18} />
                  ) : (
                    <RefreshCw size={18} className="spin" />
                  )}
                </span>
                <div>
                  <strong>
                    {r.state === "completed"
                      ? "County data refreshed"
                      : r.state === "running"
                        ? "Import in progress"
                        : "Import failed"}
                  </strong>
                  <span>{eventTime(r.startedAt)} · Utah</span>
                  <p>
                    {format.format(r.processed)} / {format.format(r.total)}{" "}
                    source records
                    {r.state === "completed"
                      ? ` · ${format.format(r.parcels)} unique parcels`
                      : ""}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      {issues.length > 0 && (
        <div className="quality-table">
          <div className="section-title">
            <h3>Records worth a closer look</h3>
            <span>First 100 records with data notes</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>PROPERTY</th>
                  <th>PARCEL ID</th>
                  <th>DATA NOTES</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <button
                        className="text-link"
                        onClick={() => onOpen(i.id)}
                      >
                        {i.address || "Address unavailable"}
                        <ArrowUpRight size={13} />
                      </button>
                    </td>
                    <td>{i.id}</td>
                    <td>{i.issues.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
