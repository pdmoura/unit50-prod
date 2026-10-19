import { useState } from "react";
import { ArrowUpRight, RefreshCw, Info, AlertCircle } from "lucide-react";
import { useAccount } from "./AuthGate";
import type { PropertyDetail } from "../shared/types";
import { post } from "./api";
import { eventTime } from "./DetailPanel";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const num = new Intl.NumberFormat("en-US");
const money = (v: number | null | undefined) =>
  v == null ? "—" : usd.format(v);
const sqft = (v: number | null | undefined) =>
  v == null ? "—" : `${num.format(v)} sq ft`;
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value ?? "—"}</strong>
    </div>
  );
}
export default function CountyPanel({
  property: p,
  onChange,
}: {
  property: PropertyDetail;
  onChange: () => void;
}) {
  // Reading Weber County Parcel Search is county data work: the super admin's.
  const { superAdmin } = useAccount();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const d = p.county?.data,
    t = d?.taxes,
    c = d?.characteristics;
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await post(`/properties/${encodeURIComponent(p.id)}/county`, {});
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const mailing = [
    p.mailAddress,
    p.mailCity,
    p.mailZip?.replace(/^(\d{5})(\d{4})$/, "$1-$2"),
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="county-panel">
      <div className="section-title">
        <h3>Owner</h3>
        {t?.ownerAsOf && <span>As of {t.ownerAsOf}</span>}
      </div>
      <div className="detail-grid">
        <Field label="Owner of record" value={p.owner || t?.owner} />
        <Field label="Mailing address" value={mailing || null} />
        <Field
          label="Loan company"
          value={t ? t.loanCompany || "None" : null}
        />
        <Field label="Account type" value={p.accountType} />
      </div>
      <div className="section-title">
        <h3>Taxes {p.taxYear ?? t?.taxYear ?? ""}</h3>
        <span>Tax area {p.taxArea ?? t?.taxArea ?? "—"}</span>
      </div>
      <div className="detail-grid">
        <Field
          label="Market value"
          value={money(p.marketValue ?? t?.marketValue)}
        />
        <Field
          label="Taxable value"
          value={money(p.taxableValue ?? t?.taxableValue)}
        />
        <Field label="Tax rate" value={p.taxRate ?? t?.taxRate} />
        <Field
          label="Net assessment charge"
          value={money(p.netAssessment ?? t?.netAssessment)}
        />
        <Field
          label="Direct charges"
          value={money(p.directCharges ?? t?.directTotal)}
        />
        <Field label="Penalty" value={money(p.penalty ?? t?.penalty)} />
        <Field
          label="Total charge"
          value={money(p.totalCharge ?? t?.subtotal)}
        />
        <Field label="Payments" value={money(p.payments ?? t?.paymentsTotal)} />
        {t && <Field label="Balance due" value={money(t.balance)} />}
      </div>
      {t && t.directCharges.length > 0 && (
        <table className="county-table">
          <thead>
            <tr>
              <th>Direct charge</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {t.directCharges.map((x, i) => (
              <tr key={i}>
                <td>{x.description}</td>
                <td>{money(x.amount)}</td>
                <td>{x.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {t && t.payments.length > 0 && (
        <table className="county-table">
          <thead>
            <tr>
              <th>Payment</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {t.payments.map((x, i) => (
              <tr key={i}>
                <td>
                  {x.date}
                  <small>{x.payee}</small>
                </td>
                <td>{money(x.amount)}</td>
                <td>{x.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="section-title">
        <h3>Lot</h3>
        {c?.assessmentYear && <span>Assessed {c.assessmentYear}</span>}
      </div>
      <div className="detail-grid">
        <Field
          label="Lot size"
          value={
            (p.acres ?? c?.acres) != null
              ? `${p.acres ?? c?.acres} acres`
              : null
          }
        />
        <Field label="Neighborhood" value={p.neighborhood || c?.neighborhood} />
        <Field label="Subdivision" value={p.subdivision} />
        <Field label="Land type" value={c?.landType} />
        <Field
          label="FAA / Greenbelt"
          value={c ? (c.greenbelt ? "Yes" : "No") : null}
        />
        <Field
          label="Quality · condition"
          value={
            p.quality != null ? `${p.quality} · ${p.condition ?? "—"}` : null
          }
        />
      </div>
      <div className="section-title">
        <h3>Buildings</h3>
        <span>{c ? c.buildings.length : "—"}</span>
      </div>
      {c ? (
        c.buildings.map((b) => (
          <div className="building-card" key={b.number}>
            <strong>
              #{b.number} · {b.type} {b.style ? `· ${b.style}` : ""}
            </strong>
            <div className="detail-grid">
              <Field label="Year built" value={b.year} />
              <Field
                label="Living area (above grade)"
                value={sqft(b.livingSqft)}
              />
              <Field
                label="Basement"
                value={
                  b.basementSqft
                    ? `${sqft(b.basementSqft)} · ${b.basementFinishPct ?? 0}% finished`
                    : "None"
                }
              />
              <Field label="Quality" value={b.quality} />
              <Field label="Exterior" value={b.exterior} />
              <Field label="Roof" value={b.roof} />
              {b.percentComplete != null && b.percentComplete < 100 && (
                <Field label="Complete" value={`${b.percentComplete}%`} />
              )}
            </div>
          </div>
        ))
      ) : (
        <p className="muted small">
          Building details come from Weber County Parcel Search. Use the button
          below to fetch them for this parcel.
        </p>
      )}
      {c && (c.sketches.length > 0 || c.platMaps.length > 0) && (
        <div className="county-links">
          {c.sketches.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              Building sketch {c.sketches.length > 1 ? i + 1 : ""}
              <ArrowUpRight size={13} />
            </a>
          ))}
          {c.platMaps.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              Plat map{" "}
              {decodeURIComponent(u.split("/").pop() || "").replace(
                /\.PDF$/i,
                "",
              )}
              <ArrowUpRight size={13} />
            </a>
          ))}
        </div>
      )}
      {p.county?.state === "error" && (
        <div className="notice error-notice">
          <AlertCircle size={17} />
          <div>
            <strong>Last Parcel Search lookup failed</strong>
            <p>{p.county.error}</p>
          </div>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {superAdmin && (
        <button
          className="secondary-button full county-refresh"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} className={busy ? "spin" : ""} />
          {busy
            ? "Reading Parcel Search…"
            : d
              ? "Refresh from Parcel Search"
              : "Fetch from Parcel Search"}
        </button>
      )}
      <p className="field-note">
        {p.county?.data &&
          `Parcel Search read ${eventTime(p.county.fetchedAt)}. `}
        Owner and tax values refresh with each county import.{" "}
        <a href={p.parcelSearchUrl} target="_blank" rel="noreferrer">
          Open in Parcel Search
        </a>
      </p>
      {!p.owner && !d && (
        <div className="notice">
          <Info size={17} />
          <p>
            No owner data yet.{" "}
            {superAdmin
              ? "Run “Refresh county data” on the Data screen to load owners and taxes for every parcel."
              : "The super admin loads owners and taxes for every parcel."}
          </p>
        </div>
      )}
    </div>
  );
}
