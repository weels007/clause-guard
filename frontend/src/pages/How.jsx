export default function How() {
  return (
    <div className="page app-shell shell prose">
      <header className="view-head">
        <div>
          <p className="eyebrow">reference</p>
          <h1>How ClauseGuard decides</h1>
        </div>
      </header>

      <section className="panel">
        <h2>What the committee compares</h2>
        <p>
          Two fields only: the <b>verdict</b> (COMPLIANT / NON_COMPLIANT / REVIEW) and the <b>risk level</b> (LOW / MEDIUM / HIGH). An
          integer score is exactly the value two independent models disagree on — and when validators disagree the transaction becomes{" "}
          <i>undetermined</i> and writes nothing.
        </p>
        <p>The stored number is a fixed representative of the agreed level: LOW 20, MEDIUM 50, HIGH 80. It cannot drift between runs.</p>
      </section>

      <section className="panel">
        <h2>When the citation is not there</h2>
        <p>
          The model must quote a sentence from the fetched page. The quote is folded to letters and digits and must appear in the page
          text. If it does not, the verdict is downgraded to <b>REVIEW</b> and the quote is dropped — the assessment still completes,
          because a hard failure would leave consensus with nothing to agree on.
        </p>
      </section>

      <section className="panel">
        <h2>Error taxonomy</h2>
        <dl className="kv kv-stack">
          <div>
            <dt>
              <code>[EXPECTED]</code>
            </dt>
            <dd>bad input, wrong caller, duplicate reference. Deterministic: both nodes must match.</dd>
          </div>
          <div>
            <dt>
              <code>[EXTERNAL]</code>
            </dt>
            <dd>the rules page is empty or gone. Deterministic, recorded instead of retried.</dd>
          </div>
          <div>
            <dt>
              <code>[TRANSIENT]</code>
            </dt>
            <dd>network or 5xx. Both nodes transient means agreement, so it retries.</dd>
          </div>
          <div>
            <dt>
              <code>[LLM_ERROR]</code>
            </dt>
            <dd>malformed model output. Always disagrees, forcing a rotation to a new leader.</dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <h2>One shared contract</h2>
        <p>
          The console talks to a single ClauseGuard deployment whose address lives in{" "}
          <code>frontend/src/config.js</code>. It is recorded once, by the <b>Deploy Contract</b> workflow, and every visitor
          reads and writes that same contract — there is no deploy button, so using the app never creates another one.
        </p>
        <p>
          Reads use a wallet-less <code>genlayer-js</code> client; writes are signed by your EVM wallet and are only shown as done
          once the committee has decided and the execution returned a value. A reverting transaction is reported with the
          contract's own error tag, and an undetermined one says so instead of keeping stale numbers.
        </p>
        <p>
          While no address is recorded yet, the header badge reads <b>simulation</b> and the same screens run against a
          deterministic stand-in with identical guards.
        </p>
      </section>

      <section className="panel">
        <h2>Money rules</h2>
        <ul className="checks">
          <li>An escrow needs a COMPLIANT assessment the funder ran themselves — one verdict backs one escrow.</li>
          <li>Only the stored funder can release or refund. The payee has no pull path.</li>
          <li>
            A refused deposit becomes an <code>ORPHAN</code> owned by the sender, refundable, instead of being stranded by a revert.
          </li>
          <li>After 30 days anyone may trigger the refund — but it always pays the funder.</li>
        </ul>
      </section>
    </div>
  );
}
