import { useEffect, useState } from "react";
import { humanizeError } from "../contract.js";
import { OWNER_ADDRESS, STRANGER_ADDRESS } from "../data.js";
import { formatWei, shortAddress } from "../format.js";
import { Pill, toast } from "../ui.jsx";

const EMPTY_FUND = { assessment_id: "", payee: "", amount: "1000", reference: "" };

export default function Escrows({ contract, state }) {
  const [open, setOpen] = useState(false);
  const [fund, setFund] = useState(EMPTY_FUND);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const actor = contract.actorAddress();
  const escrows = Object.values(state.escrows).sort((a, b) => a.escrow_id.localeCompare(b.escrow_id, undefined, { numeric: true }));

  const eligible = Object.values(state.assessments).filter(
    (item) => item.verdict === "COMPLIANT" && item.requester.toLowerCase() === actor.toLowerCase() && !state.usedAssessments[item.assessment_id]
  );

  useEffect(() => {
    if (!open) return;
    setFund({
      assessment_id: eligible[0]?.assessment_id || "",
      payee: actor.toLowerCase() === state.owner.toLowerCase() ? STRANGER_ADDRESS : state.owner,
      amount: "1000",
      reference: "",
    });
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (event) => setFund((current) => ({ ...current, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!fund.assessment_id) {
      setError("You need a COMPLIANT assessment you ran yourself. Run one on the Assess page first.");
      return;
    }
    setBusy(true);
    setError("");
    await new Promise((resolve) => setTimeout(resolve, 160));
    try {
      const escrow = await contract.createEscrow(fund);
      if (escrow && escrow.status === "ORPHAN") {
        toast("error", "Deposit held as ORPHAN", `Refused: ${escrow.refusal}. It is recorded against you and refundable.`);
      } else if (escrow) {
        toast("ok", "Escrow funded", `${formatWei(escrow.amount)} wei locked in ${escrow.escrow_id}.`);
      } else {
        toast("ok", "Deposit accepted", "The transaction is on chain; press Refresh on the Dashboard to read it.");
      }
      setOpen(false);
    } catch (err) {
      const message = humanizeError(err);
      setError(message);
      toast("error", "Deposit refused", message);
    } finally {
      setBusy(false);
    }
  };

  const settle = async (escrow, kind) => {
    const verb = kind === "release" ? "release" : "refund";
    const target = kind === "release" ? "the payee" : "the funder";
    if (!window.confirm(`${verb} ${formatWei(escrow.amount)} wei to ${target}?`)) return;
    try {
      if (kind === "release") await contract.releaseEscrow(escrow.escrow_id);
      else await contract.refundEscrow(escrow.escrow_id);
      toast("ok", `Escrow ${verb}d`, `${escrow.escrow_id} · ${formatWei(escrow.amount)} wei sent to ${target}.`);
    } catch (err) {
      toast("error", "Not settled", humanizeError(err));
    }
  };

  return (
    <div className="page app-shell shell">
      <header className="view-head">
        <div>
          <p className="eyebrow">custody</p>
          <h1>Escrows</h1>
        </div>
        <div className="view-actions">
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setOpen((value) => !value)}>
            Fund an escrow
          </button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2>Holdings</h2>
          <span className={`pill ${contract.ledgerOk() ? "ok" : "bad"}`}>
            locked {formatWei(state.ledger.locked_total)} · out {formatWei(state.ledger.total_out)}
          </span>
        </div>

        {escrows.length ? (
          <ul className="list">
            {escrows.map((escrow) => {
              const isFunder = escrow.funder.toLowerCase() === actor.toLowerCase();
              const stillOpen = escrow.status === "FUNDED" || escrow.status === "ORPHAN";
              const expired = contract.isEscrowExpired(escrow);
              const canAct = stillOpen && (isFunder || expired);
              return (
                <li className="escrow-card" key={escrow.escrow_id}>
                  <div className="escrow-top">
                    <div>
                      <div className="list-title">
                        {escrow.escrow_id} · {formatWei(escrow.amount)} wei
                      </div>
                      <div className="list-sub">
                        {shortAddress(escrow.funder)} → {shortAddress(escrow.payee)}
                        {escrow.reference ? ` · ${escrow.reference}` : ""}
                      </div>
                    </div>
                    <Pill status={escrow.status} />
                  </div>

                  {escrow.status === "ORPHAN" && (
                    <p className="escrow-warning">
                      Refused deposit ({escrow.refusal}). It belongs to the sender and can be refunded.
                    </p>
                  )}

                  {stillOpen && (
                    <div className="escrow-actions">
                      {canAct && escrow.status === "FUNDED" && (
                        <button className="btn btn-primary btn-sm" type="button" onClick={() => settle(escrow, "release")}>
                          Release to payee
                        </button>
                      )}
                      {canAct && (
                        <button className="btn btn-ghost btn-sm" type="button" onClick={() => settle(escrow, "refund")}>
                          Refund to funder
                        </button>
                      )}
                      {!canAct && <span className="hint">Only the funder can move this escrow.</span>}
                      {expired && <span className="hint">Timeout active: anyone may trigger the refund.</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty">No escrows yet. Fund one against a COMPLIANT assessment.</p>
        )}
      </section>

      {open && (
        <section className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h2>Fund an escrow</h2>
            <button className="icon-btn" type="button" aria-label="Close" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>

          <form className="form" onSubmit={submit}>
            <label className="field">
              <span className="field-label">COMPLIANT assessment</span>
              <select name="assessment_id" value={fund.assessment_id} onChange={update}>
                {eligible.length ? (
                  eligible.map((item) => (
                    <option key={item.assessment_id} value={item.assessment_id}>
                      {item.assessment_id} — {item.subject} ({item.risk_band})
                    </option>
                  ))
                ) : (
                  <option value="">No eligible COMPLIANT assessment</option>
                )}
              </select>
              <span className="field-hint">Only a verdict you ran yourself, with verdict COMPLIANT, can back an escrow.</span>
            </label>

            <div className="field-row">
              <label className="field">
                <span className="field-label">Payee</span>
                <input name="payee" value={fund.payee} onChange={update} placeholder="0x…" />
              </label>
              <label className="field">
                <span className="field-label">Amount (wei)</span>
                <input name="amount" value={fund.amount} onChange={update} inputMode="numeric" placeholder="1000" />
              </label>
            </div>

            <label className="field">
              <span className="field-label">Reference</span>
              <input name="reference" value={fund.reference} onChange={update} placeholder="PO-1" />
            </label>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <div className="form-actions">
              <button className="btn btn-primary" type="submit" aria-busy={busy} disabled={busy}>
                {busy ? <span className="spin" /> : null}
                Deposit
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
