import { useState } from "react";
import { explorerAddress } from "../chain.js";
import { humanizeError } from "../contract.js";
import { formatWei, shortAddress } from "../format.js";
import { Chip, toast } from "../ui.jsx";

const ZERO = "0x" + "0".repeat(40);

function NetworkPanel({ contract, state }) {
  const [draft, setDraft] = useState(state.address || "");
  const [deploying, setDeploying] = useState(false);
  const onChain = state.mode === "chain";
  const connected = Boolean(state.wallet?.address);

  const deploy = async () => {
    if (deploying) return;
    setDeploying(true);
    try {
      const address = await contract.deploy();
      toast("ok", "Contract deployed", `${shortAddress(address)} · GenLayer Studio.`);
    } catch (error) {
      toast("error", "Deploy failed", humanizeError(error));
    } finally {
      setDeploying(false);
    }
  };

  const useAddress = () => {
    try {
      contract.setAddress(draft);
      toast("ok", "Contract set", `${shortAddress(draft)} · reading from the chain.`);
    } catch (error) {
      toast("error", "Address rejected", humanizeError(error));
    }
  };

  const refresh = async () => {
    await contract.refresh();
    toast("ok", "Refreshed", "Reads come straight from the contract.");
  };

  const forget = () => {
    contract.clearAddress();
    setDraft("");
    toast("ok", "Back to simulation", "The console is showing the local mock again.");
  };

  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h2>Contract</h2>
        <span className={`pill ${onChain ? "ok" : "warn"}`}>{onChain ? "on-chain" : "simulation"}</span>
      </div>

      {onChain ? (
        <>
          <dl className="kv">
            <div>
              <dt>address</dt>
              <dd>{shortAddress(state.address, 10, 8)}</dd>
            </div>
            <div>
              <dt>network</dt>
              <dd>GenLayer Studio · 61999</dd>
            </div>
            <div>
              <dt>balance</dt>
              <dd>{formatWei(state.balance)} wei</dd>
            </div>
            <div>
              <dt>owner</dt>
              <dd>{state.owner ? shortAddress(state.owner) : "—"}</dd>
            </div>
          </dl>
          <div className="form-actions" style={{ marginTop: 14 }}>
            <button className="btn btn-ghost btn-sm" type="button" onClick={refresh} disabled={state.loading}>
              {state.loading ? <span className="spin" /> : null}
              {state.loading ? "Reading…" : "Refresh"}
            </button>
            <a
              className="btn btn-ghost btn-sm"
              href={explorerAddress(state.address)}
              target="_blank"
              rel="noreferrer noopener"
            >
              Explorer
            </a>
            <button className="btn btn-ghost btn-sm" type="button" onClick={forget}>
              Forget
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            This is the simulated contract. Connect a wallet on GenLayer Studio and deploy the bundled ClauseGuard source, or paste an
            existing address — every read and write then goes to the chain.
          </p>
          <div className="field-row" style={{ marginTop: 12 }}>
            <label className="field">
              <span className="field-label">Contract address</span>
              <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="0x…" />
            </label>
            <div style={{ display: "flex", alignItems: "end", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-ghost" type="button" onClick={useAddress}>
                Use address
              </button>
              <button className="btn btn-primary" type="button" onClick={deploy} disabled={!connected || deploying}>
                {deploying ? <span className="spin" /> : null}
                {deploying ? "Deploying…" : "Deploy"}
              </button>
            </div>
          </div>
          {!connected && <p className="hint">Connect an EVM wallet first (top right) to deploy.</p>}
          {deploying && <p className="hint">Deploying takes a minute: the committee has to agree on the contract.</p>}
        </>
      )}

      {state.chainError && (
        <div className="form-error" style={{ marginTop: 12 }}>
          {state.chainError}
        </div>
      )}
      {state.tx && (
        <p className="hint" style={{ marginBottom: 0 }}>
          transaction · {state.tx.stage}
          {state.tx.hash ? ` · ${shortAddress(state.tx.hash, 10, 8)}` : ""}
        </p>
      )}
    </section>
  );
}

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
          {state.mode !== "chain" && (
            <button className="btn btn-ghost btn-sm" type="button" onClick={reset}>
              Reset data
            </button>
          )}
        </div>
      </header>

      <NetworkPanel contract={contract} state={state} />

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
            <p className="empty">{state.mode === "chain" ? "Nothing stored on the contract yet." : "No assessments yet."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
