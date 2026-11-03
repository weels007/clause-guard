import { formatWei } from "../format.js";
import { Chip, Reveal, Seal } from "../ui.jsx";

const STEPS = [
  {
    n: "01",
    title: "Policy registered",
    body: "The owner stores a rules URL and analyst guidance. Once a policy has produced an assessment it locks, so it can never be re-pointed underneath old verdicts.",
  },
  {
    n: "02",
    title: "Rules fetched",
    body: "Inside the non-deterministic block the contract renders the page as text. The excerpt is digested, so an auditor can tell which text produced the verdict.",
  },
  {
    n: "03",
    title: "Committee decides",
    body: "The model returns a verdict, a risk level and a verbatim citation. A citation that is not in the page cannot certify anything — the verdict drops to REVIEW.",
  },
  {
    n: "04",
    title: "Stored on consensus",
    body: "Validators re-run the fetch and the judgement, then compare verdict and risk level. Disagreement writes nothing at all.",
  },
];

const FEATURES = [
  {
    title: "Grounded citations",
    body: "Quotes are folded to letters and digits and matched against the fetched page, so formatting cannot fake or break evidence.",
  },
  {
    title: "No double submit",
    body: "Every assessment carries a caller-scoped submit_ref. A replay is refused instead of minting a second record.",
  },
  {
    title: "Funder-only custody",
    body: "Only the depositor can release or refund, and a refused deposit becomes a refundable orphan rather than a stranded one.",
  },
  {
    title: "Bounded work",
    body: "Capped policies, capped assessments and a summary that reads counters instead of walking the whole set.",
  },
];

export default function Landing({ state }) {
  const assessments = Object.values(state.assessments);
  const review = assessments.filter((item) => item.verdict === "REVIEW").length;
  const featured =
    assessments.find((item) => item.verdict === "COMPLIANT" && item.rule_quote) ||
    assessments.find((item) => item.rule_quote) ||
    assessments[0];

  return (
    <div className="page">
      <section className="hero shell">
        <div className="hero-copy">
          <p className="eyebrow">Intelligent contract · GenLayer</p>
          <h1 className="display">
            Compliance decisions <span className="mark">that show their work.</span>
          </h1>
          <p className="lede">
            ClauseGuard fetches a policy's rules from the web, asks an AI committee whether a transaction complies, and stores the
            verdict with the exact citation it relied on.
          </p>
          <p className="lede">Every validator re-derives the answer before anything is written.</p>

          <div className="actions">
            <a className="btn btn-primary" href="#/assess">
              Run an assessment
            </a>
            <a className="btn btn-ghost" href="#/how">
              How consensus works
            </a>
          </div>

          <dl className="hero-stats">
            <div>
              <dt>policies</dt>
              <dd>{Object.keys(state.policies).length}</dd>
            </div>
            <div>
              <dt>assessments</dt>
              <dd>{assessments.length}</dd>
            </div>
            <div>
              <dt>for review</dt>
              <dd>{review}</dd>
            </div>
            <div>
              <dt>locked GEN</dt>
              <dd>{formatWei(state.ledger.locked_total)}</dd>
            </div>
          </dl>
        </div>

        <div className="hero-visual">
          <Seal />
          {featured && (
            <article className="docket">
              <div className="docket-head">
                <Chip verdict={featured.verdict} />
                <span className="docket-id">{featured.assessment_id}</span>
              </div>
              <p className="docket-subject">
                {featured.subject} → {featured.counterparty || "—"}
              </p>
              <div className="docket-meta">
                <span>
                  risk<b>{featured.risk_band}</b>
                </span>
                <span>
                  score<b>{featured.risk_score}</b>
                </span>
                <span>
                  policy<b>{featured.policy_id}</b>
                </span>
              </div>
              {featured.rule_quote ? <blockquote className="docket-quote">“{featured.rule_quote}”</blockquote> : null}
              <div className="docket-foot">
                <span className="dot-ok" />
                {featured.rule_quote ? "citation grounded in source" : "no citation · downgraded to review"}
              </div>
            </article>
          )}
        </div>
      </section>

      <div className="ribbon-wrap" aria-hidden="true">
        <div className="ribbon">
          {[0, 1].map((copy) => (
            <span key={copy}>
              rules fetched at assessment time <i>◆</i> citation verified against the page <i>◆</i> validators agree on verdict and
              level <i>◆</i> funds release only on COMPLIANT <i>◆</i>
            </span>
          ))}
        </div>
      </div>

      <div className="shell section">
        <Reveal className="section-head">
          <p className="eyebrow">how it works</p>
          <h2>Four steps, one auditable trail</h2>
          <p>The model proposes. Deterministic code decides. Validators check independently.</p>
        </Reveal>

        <ol className="steps">
          {STEPS.map((step, index) => (
            <li key={step.n} style={{ animationDelay: `${index * 70}ms` }}>
              <span className="step-num">{step.n}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="shell section">
        <Reveal className="section-head">
          <p className="eyebrow">why it holds</p>
          <h2>Built so the failure modes are boring</h2>
        </Reveal>
        <div className="feature-grid">
          {FEATURES.map((feature, index) => (
            <article key={feature.title} className="feature" style={{ animationDelay: `${index * 60}ms` }}>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </div>

      <div className="shell section">
        <div className="cta-band">
          <div>
            <h2>Open the console</h2>
            <p>Register a policy, run an assessment, then fund an escrow and unwind it. Every action maps to a real contract method.</p>
          </div>
          <a className="btn btn-primary" href="#/dashboard">
            Go to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
