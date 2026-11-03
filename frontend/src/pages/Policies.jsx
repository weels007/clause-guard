import { useState } from "react";
import { humanizeError } from "../contract.js";
import { shortAddress } from "../format.js";
import { toast } from "../ui.jsx";

const EMPTY = { policy_id: "", name: "", source_url: "", guidance: "" };
const ZERO = "0x" + "0".repeat(40);

export default function Policies({ contract, state }) {
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nominee, setNominee] = useState("");

  const policies = Object.values(state.policies).sort((a, b) => a.policy_id.localeCompare(b.policy_id));
  const isOwner = contract.isOwner();
  const connected = Boolean(state.wallet?.address);
  const pending = state.pendingOwner !== ZERO;

  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    /* A tick of latency so the busy state is visible and a double click cannot land twice. */
    await new Promise((resolve) => setTimeout(resolve, 160));
    try {
      if (editing) {
        await contract.updatePolicy({ ...form, policy_id: editing });
        toast("ok", "Policy updated", "The rules URL is saved before any assessment uses it.");
      } else {
        await contract.registerPolicy(form);
        toast("ok", "Policy registered", "It locks once its first assessment runs.");
      }
      setEditing(null);
      setForm(EMPTY);
    } catch (err) {
      const message = humanizeError(err);
      setError(message);
      toast("error", "Policy not saved", message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (policy) => {
    setEditing(policy.policy_id);
    setForm({
      policy_id: policy.policy_id,
      name: policy.name,
      source_url: policy.source_url,
      guidance: policy.guidance,
    });
    setError("");
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(EMPTY);
    setError("");
  };

  const toggle = async (policy) => {
    try {
      await contract.setPolicyActive(policy.policy_id, !policy.active);
      toast("ok", policy.active ? "Policy disabled" : "Policy enabled", `Assessments can${policy.active ? " no longer" : " now"} use it.`);
    } catch (err) {
      toast("error", "Not changed", humanizeError(err));
    }
  };

  const nominate = async () => {
    try {
      await contract.transferOwnership(nominee);
      setNominee("");
      toast("ok", "Nominated", "The successor must accept before ownership moves.");
    } catch (err) {
      toast("error", "Not nominated", humanizeError(err));
    }
  };

  const accept = async () => {
    try {
      await contract.acceptOwnership();
      toast("ok", "Ownership moved", "You are now the contract owner.");
    } catch (err) {
      toast("error", "Ownership not accepted", humanizeError(err));
    }
  };

  return (
    <div className="page app-shell shell">
      <header className="view-head">
        <div>
          <p className="eyebrow">registry</p>
          <h1>Policies</h1>
        </div>
        <div className="view-actions">
          <span className="pill">{policies.length}/100</span>
        </div>
      </header>

      {connected && !isOwner && (
        <p className="wallet-note">
          Your wallet ({shortAddress(contract.actorAddress())}) is not the contract owner, so policy writes are refused. Act as the demo
          owner to register one.
        </p>
      )}

      <div className="two-col policies-layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Registered</h2>
            <span className="pill">{policies.length}</span>
          </div>
          {policies.length ? (
            <ul className="list">
              {policies.map((policy) => (
                <li className="list-item" key={policy.policy_id}>
                  <div className="list-main">
                    <div className="list-title">{policy.name}</div>
                    <div className="list-sub">
                      {policy.policy_id} · v{policy.version} · {policy.assessments} assessments
                    </div>
                  </div>
                  <div className="list-side">
                    <span className={`pill ${policy.active ? "ok" : ""}`}>{policy.active ? "live" : "off"}</span>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => toggle(policy)}>
                      {policy.active ? "Disable" : "Enable"}
                    </button>
                    {policy.assessments === 0 ? (
                      <button className="btn btn-ghost btn-sm" type="button" onClick={() => startEdit(policy)}>
                        Edit
                      </button>
                    ) : (
                      <span className="pill" title="A policy that produced assessments is locked">
                        locked
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No policies yet.</p>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{editing ? `Edit ${form.name || editing}` : "Register a policy"}</h2>
            {editing && (
              <button className="btn btn-ghost btn-sm" type="button" onClick={cancelEdit}>
                Cancel
              </button>
            )}
          </div>

          <form className="form" onSubmit={submit}>
            <label className="field">
              <span className="field-label">Policy id</span>
              <input
                name="policy_id"
                value={form.policy_id}
                onChange={update}
                readOnly={Boolean(editing)}
                placeholder="eu-payments"
                autoComplete="off"
              />
              <span className="field-hint">Lowercase; letters, digits and - _ .</span>
            </label>

            <label className="field">
              <span className="field-label">Name</span>
              <input name="name" value={form.name} onChange={update} placeholder="EU payments screen" />
            </label>

            <label className="field">
              <span className="field-label">Rules URL</span>
              <input
                name="source_url"
                value={form.source_url}
                onChange={update}
                placeholder="https://rules.example.com/eu"
                inputMode="url"
              />
              <span className="field-hint">https on a public host. IP literals, localhost and internal names are refused.</span>
            </label>

            <label className="field">
              <span className="field-label">Analyst guidance</span>
              <textarea
                name="guidance"
                value={form.guidance}
                onChange={update}
                rows={3}
                placeholder="What the reviewer should pay attention to"
              />
            </label>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            <div className="form-actions">
              <button className="btn btn-primary" type="submit" aria-busy={busy} disabled={busy}>
                {busy ? <span className="spin" /> : null}
                {editing ? "Save changes" : "Register policy"}
              </button>
            </div>
          </form>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>Contract ownership</h2>
          <span className={`pill ${pending ? "warn" : "ok"}`}>{pending ? "handover pending" : "settled"}</span>
        </div>
        <dl className="kv">
          <div>
            <dt>owner</dt>
            <dd>{shortAddress(state.owner)}</dd>
          </div>
          <div>
            <dt>nominated</dt>
            <dd>{pending ? shortAddress(state.pendingOwner) : "—"}</dd>
          </div>
        </dl>
        <div className="field-row" style={{ marginTop: 14 }}>
          <label className="field">
            <span className="field-label">Nominate a successor</span>
            <input value={nominee} onChange={(event) => setNominee(event.target.value)} placeholder="0x…" />
          </label>
          <div style={{ display: "flex", alignItems: "end" }}>
            <button className="btn btn-ghost" type="button" onClick={nominate}>
              Nominate
            </button>
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary btn-sm" type="button" onClick={accept}>
            Accept as nominee
          </button>
        </div>
        <p className="hint">Two-step on purpose: a mistyped address cannot take ownership by itself.</p>
      </section>
    </div>
  );
}
