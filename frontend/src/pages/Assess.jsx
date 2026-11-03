import { useEffect, useState } from "react";
import { explorerTx } from "../chain.js";
import { humanizeError } from "../contract.js";
import { newSubmitRef, shortAddress } from "../format.js";
import { Chip, toast } from "../ui.jsx";

const STEPS = ["Render the rules page", "Committee decides", "Validators re-derive", "Write the agreed verdict"];

function verdictPill(verdict) {
  return verdict === "COMPLIANT" ? "ok" : verdict === "NON_COMPLIANT" ? "bad" : "warn";
}

function Progress({ step }) {
  return (
    <div className="progress">
      {STEPS.map((label, index) => {
        const state = index < step ? "done" : index === step ? "active" : "";
        return (
          <div className={`progress-step ${state}`} key={label}>
            <span className="dot" aria-hidden="true" />
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function Verdict({ record, receipt, hash }) {
  const grounded = Boolean(record.rule_quote);
  return (
    <div className="result-body">
      <div className="verdict-head">
        <div>
          <div className="title">
            {record.subject} → {record.counterparty || "—"}
          </div>
          <div className="sub">
            {record.assessment_id} · {record.policy_id} v{record.policy_version}
          </div>
        </div>
        <Chip verdict={record.verdict} />
      </div>

      <div className="detail-grid">
        {[
          ["risk", record.risk_band],
          ["score", record.risk_score],
          ["amount", record.amount || "—"],
          ["requester", shortAddress(record.requester)],
        ].map(([label, value]) => (
          <div className="detail" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      {grounded ? (
        <>
          <blockquote className="quote-block">“{record.rule_quote}”</blockquote>
          <p className="hint" style={{ marginTop: 0 }}>
            <span className="dot-ok" style={{ display: "inline-block", marginRight: 6 }} />
            Citation found verbatim in the fetched rules.
          </p>
        </>
      ) : (
        <div className="form-error" role="status">
          The model could not quote the source, so the verdict was downgraded to REVIEW and the citation dropped.
        </div>
      )}

      <div className="consensus">
        <header>
          <span>committee</span>
          <span>{record.consensus?.rotations ? `${record.consensus.rotations} rotation(s)` : "first leader"}</span>
        </header>
        <div className="row">
          <span>leader verdict</span>
          <span className="agree">{record.consensus?.verdict || record.verdict}</span>
        </div>
        <div className="row">
          <span>risk level compared</span>
          <span className="agree">{record.risk_band}</span>
        </div>
        <div className="row">
          <span>citation grounded</span>
          <span className={grounded ? "agree" : "disagree"}>{grounded ? "yes" : "no — downgraded"}</span>
        </div>
      </div>

      <p className="hint" style={{ marginTop: 0 }}>
        <b>Findings.</b> {record.findings}
      </p>
      <p className="hint" style={{ marginTop: 0 }}>
        rules_digest {shortAddress(record.rules_digest, 16, 10)}
      </p>

      {receipt && (
        <div className="consensus">
          <header>
            <span>on-chain receipt</span>
            <span>{receipt.status || "decided"}</span>
          </header>
          <div className="row">
            <span>execution</span>
            <span className="agree">{receipt.execution || "—"}</span>
          </div>
          <div className="row">
            <span>leader vote</span>
            <span className="agree">{receipt.leaderVote || "—"}</span>
          </div>
          <div className="row">
            <span>validators</span>
            <span>{receipt.validators || 0}</span>
          </div>
          <div className="row">
            <span>rounds</span>
            <span>{receipt.rounds ?? "—"}</span>
          </div>
          {hash && (
            <div className="row">
              <span>transaction</span>
              <a className="link" href={explorerTx(hash)} target="_blank" rel="noreferrer noopener">
                {shortAddress(hash, 10, 8)}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Assess({ contract, state }) {
  const active = Object.values(state.policies)
    .filter((policy) => policy.active)
    .sort((a, b) => a.policy_id.localeCompare(b.policy_id));

  const [form, setForm] = useState({
    policy_id: active[0]?.policy_id || "",
    subject: "ACME GmbH",
    counterparty: "Acme Supplier GmbH",
    amount: "4200 EUR",
    context: "Monthly SaaS invoice, first-time vendor",
    submit_ref: newSubmitRef(),
  });
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(-1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setForm((current) => {
      if (current.policy_id && active.some((policy) => policy.policy_id === current.policy_id)) return current;
      return { ...current, policy_id: active[0]?.policy_id || "" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length]);

  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (running) return;
    setRunning(true);
    setError("");
    setResult(null);

    for (let index = 0; index < STEPS.length; index += 1) {
      setStep(index);
      await new Promise((resolve) => setTimeout(resolve, 320));
    }

    try {
      const record = await contract.assess(form);
      if (!record) {
        throw new Error("The transaction was accepted, but the verdict is not readable yet. Press Refresh on the Dashboard.");
      }
      setForm((current) => ({ ...current, submit_ref: newSubmitRef() }));
      setResult(record);
      toast("ok", "Verdict recorded", `${record.assessment_id} · ${record.verdict} · ${record.risk_band} risk.`);
    } catch (err) {
      const message = humanizeError(err);
      setError(message);
      toast("error", "Assessment refused", message);
    } finally {
      setStep(-1);
      setRunning(false);
    }
  };

  return (
    <div className="page app-shell shell">
      <header className="view-head">
        <div>
          <p className="eyebrow">assessment</p>
          <h1>Assess a transaction</h1>
        </div>
      </header>

      <div className="assess-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Transaction under review</h2>
          </div>

          <form className="form" onSubmit={submit}>
            <label className="field">
              <span className="field-label">Policy</span>
              <select name="policy_id" value={form.policy_id} onChange={update}>
                {active.length ? (
                  active.map((policy) => (
                    <option key={policy.policy_id} value={policy.policy_id}>
                      {policy.name} — {policy.policy_id}
                    </option>
                  ))
                ) : (
                  <option value="">No active policy</option>
                )}
              </select>
            </label>

            <div className="field-row">
              <label className="field">
                <span className="field-label">Subject</span>
                <input name="subject" value={form.subject} onChange={update} placeholder="ACME GmbH" />
              </label>
              <label className="field">
                <span className="field-label">Counterparty</span>
                <input name="counterparty" value={form.counterparty} onChange={update} placeholder="Acme Supplier GmbH" />
              </label>
            </div>

            <label className="field">
              <span className="field-label">Amount</span>
              <input name="amount" value={form.amount} onChange={update} placeholder="4200 EUR" />
            </label>

            <label className="field">
              <span className="field-label">Context</span>
              <textarea
                name="context"
                value={form.context}
                onChange={update}
                rows={3}
                placeholder="Monthly SaaS invoice, first-time vendor"
              />
            </label>

            <div className="field-row ref-row">
              <label className="field">
                <span className="field-label">Submit reference</span>
                <input name="submit_ref" value={form.submit_ref} onChange={update} />
              </label>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setForm((current) => ({ ...current, submit_ref: newSubmitRef() }))}
              >
                Regenerate
              </button>
            </div>
            <p className="hint">A retry is safe: the contract refuses a replay of the same caller and reference.</p>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <div className="form-actions">
              <button className="btn btn-primary" type="submit" aria-busy={running} disabled={running}>
                {running ? <span className="spin" /> : null}
                Run assessment
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Result</h2>
            <span className={`pill ${running ? "warn" : result ? verdictPill(result.verdict) : ""}`}>
              {running ? "running" : result ? result.verdict.toLowerCase() : "idle"}
            </span>
          </div>

          {running && <Progress step={step} />}
          {!running && result && <Verdict record={result} receipt={state.tx?.consensus} hash={state.tx?.hash} />}
          {!running && !result && !error ? (
            <p className="empty">Run an assessment to see the verdict, the citation it relied on, and what the committee compared.</p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
