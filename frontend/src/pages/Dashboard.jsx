import { formatWei, shortAddress } from "../format.js";
import { Chip, toast } from "../ui.jsx";

const ZERO = "0x" + "0".repeat(40);

export default function Dashboard({ contract, state }) {
  const list = Object.values(state.assessments);
  const recent = [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 6);
  const ok = contract.ledgerOk();

  const stats = [
    ["policies", Object.keys(state.policies).length],
    ["assessments", list.length],
    ["compliant", list.filter((item) => item.verdict === "COMPLIANT").length],
    ["non-compliant", list.filter((item) => item.verdict === "NON_COMPLIANT").length],
    ["review", list.filter((item) => item.verdict === "REVIEW").length],
    ["high risk", list.filter((item) => item.risk_band === "HIGH").length],
  ];

  const ledger = [
    ["total deposited", formatWei(state.ledger.total_deposited)],
    ["total out", formatWei(state.ledger.total_out)],
    ["locked total", formatWei(state.ledger.locked_total)],
    ["contract balance", formatWei(state.balance)],
    ["owner", shortAddress(state.owner)],
    ["pending owner", state.pendingOwner === ZERO ? "—" : shortAddress(state.pendingOwner)],
  ];

  const reset = () => {
    if (!window.confirm("Reset the simulated contract to the seeded demo?")) return;
    contract.reset();
    toast("ok", "Reset", "The simulated contract is back to the seeded demo.");
  };

  return (
    <div className="page app-shell shell">
      <header className="view-head">
        <div>
          <p className="eyebrow">dashboard</p>
          <h1>The ledger</h1>
        </div>
        <div className="view-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>
            Reset data
          </button>
        </div>
      </header>

      <div className="stat-grid">
        {stats.map((item) => (
          <div className="stat" key={item[0]}>
            <span>{item[0]}</span>
            <strong>{item[1]}</strong>
          </div>
        ))}
      </div>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Custody ledger</h2>
            <span className={`pill ${ok ? "ok" : "bad"}`}>{ok ? "balanced" : "out of balance"}</span>
          </div>
          <dl className="kv">
            {ledger.map((row) => (
              <div key={row[0]}>
                <dt>{row[0]}</dt>
                <dd>{row[1]}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">
            Invariant <code>total_deposited = total_out + locked_total</code>. The live balance is the second net.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Recent assessments</h2>
            <a className="link" href="#/assess">
              new →
            </a>
          </div>
          {recent.length ? (
            <ul className="list">
              {recent.map((record) => (
                <li className="list-item" key={record.assessment_id}>
                  <div className="list-main">
                    <div className="list-title">{record.subject}</div>
                    <div className="list-sub">
                      {record.assessment_id} · {record.policy_id} · {record.risk_band}
                    </div>
                  </div>
                  <div className="list-side">
                    <Chip verdict={record.verdict} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No assessments yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}
