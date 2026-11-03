/** Simulated ClauseGuard contract.
 *
 * This mirrors contracts/ClauseGuard.py: the same guards, the same statuses,
 * the same ledger invariant, the same duplicate-submit rule. It is a stand-in so
 * every flow in the console works offline and deterministically; swapping this
 * module for a genlayer_py/genlayer-js client is the only change a live wiring
 * would need.
 */
import {
  DEMO_ASSESSMENTS,
  DEMO_ESCROWS,
  DEMO_POLICIES,
  OWNER_ADDRESS,
  STRANGER_ADDRESS,
} from "./data.js";

export class ContractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const STORAGE_KEY = "clauseguard.sim.v1";
const ZERO = "0x" + "0".repeat(40);
const BAND_SCORE = { LOW: 20, MEDIUM: 50, HIGH: 80 };
const POLICY_ID_ALPHABET = /^[a-z0-9._-]+$/;

function sanitize(value, limit) {
  return String(value ?? "")
    .replace(/</g, "[")
    .replace(/>/g, "]")
    .split(/\s+/)
    .join(" ")
    .trim()
    .slice(0, limit);
}

function normalizePolicyId(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) throw new ContractError("[EXPECTED]:empty_policy_id", "A policy id is required.");
  if (!POLICY_ID_ALPHABET.test(value))
    throw new ContractError("[EXPECTED]:invalid_policy_id", "Policy ids may only use letters, digits and - _ .");
  if (value.length > 64) throw new ContractError("[EXPECTED]:policy_id_too_long", "That policy id is too long.");
  return value;
}

/** The same host rules the contract applies before it stores a source URL. */
export function validateSourceUrl(raw) {
  const value = String(raw ?? "").trim();
  if (!value.startsWith("https://")) return "invalid_source_url";
  let host = "";
  try {
    host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "invalid_source_url";
  }
  if (!host) return "invalid_source_url";
  if (host.includes("localhost") || host.includes("metadata.google")) return "invalid_source_url";
  if ([".local", ".internal", ".localhost", ".nip.io", ".sslip.io"].some((suffix) => host.endsWith(suffix)))
    return "invalid_source_url";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return "invalid_source_url";
  if (value.length > 400) return "source_url_too_long";
  return null;
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function pickQuote(rules, keywords) {
  const sentences = String(rules || "").match(/[^.!?]+[.!?]*/g) || [];
  const cleaned = sentences.map((sentence) => sentence.trim()).filter(Boolean);
  if (!cleaned.length) return "";
  const lowered = keywords.toLowerCase();
  const matching = cleaned.find((sentence) =>
    sentence
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 4)
      .some((word) => lowered.includes(word))
  );
  return (matching || cleaned[0]).slice(0, 240);
}

/** A deterministic stand-in for the committee: same inputs, same verdict. */
function decide(policy, form) {
  const rules = policy.rules || "";
  const haystack = `${form.subject} ${form.counterparty} ${form.amount} ${form.context}`.toLowerCase();
  const serialised = `${policy.policy_id}|${haystack}`;
  const roll = hash(serialised) % 100;

  const sanctions = /sanction|ofac|blocked|denied/.test(haystack);
  const prohibitedRules = /prohibit|prohibited|refused|must be refused/.test(rules);

  let verdict;
  if (sanctions && prohibitedRules) verdict = "NON_COMPLIANT";
  else if (roll < 62) verdict = "COMPLIANT";
  else if (roll < 84) verdict = "REVIEW";
  else verdict = "NON_COMPLIANT";

  const level = verdict === "COMPLIANT" ? (roll % 2 === 0 ? "LOW" : "MEDIUM") : verdict === "NON_COMPLIANT" ? "HIGH" : "MEDIUM";

  const quote = pickQuote(rules, haystack);
  const quoteFolded = quote.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rulesFolded = rules.toLowerCase().replace(/[^a-z0-9]/g, "");
  const grounded = quoteFolded.length >= 20 && rulesFolded.includes(quoteFolded);

  const rotations = grounded ? (roll % 3) : 1;
  return {
    verdict: grounded ? verdict : "REVIEW",
    risk_level: grounded ? level : "MEDIUM",
    rule_quote: grounded ? quote : "",
    grounded,
    rotations,
  };
}

function digest(text) {
  const filler = hash(text).toString(16).padStart(8, "0");
  return (filler + filler + filler + filler + filler + filler + filler + filler).slice(0, 64);
}

function initialState() {
  const policies = {};
  for (const policy of DEMO_POLICIES) policies[policy.policy_id] = { ...policy };
  const assessments = {};
  for (const assessment of DEMO_ASSESSMENTS) assessments[assessment.assessment_id] = { ...assessment };
  const escrows = {};
  for (const escrow of DEMO_ESCROWS) escrows[escrow.escrow_id] = { ...escrow };

  return {
    owner: OWNER_ADDRESS,
    pendingOwner: ZERO,
    policies,
    assessments,
    escrows,
    usedAssessments: { "ca-1": true },
    submitRefs: {
      [`${OWNER_ADDRESS}|demo-1`]: "ca-1",
      [`${OWNER_ADDRESS}|demo-2`]: "ca-2",
      [`${OWNER_ADDRESS}|demo-3`]: "ca-3",
    },
    nextAssessmentId: 4,
    nextEscrowId: 2,
    ledger: { total_deposited: 1000, total_out: 0, locked_total: 1000 },
    balance: 1000,
    actor: "owner",
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw);
    /* localStorage is attacker-writable in a shared browser: only trust a
       snapshot that still has every collection the store reads. */
    if (!parsed || !parsed.policies || !parsed.assessments || !parsed.escrows || !parsed.ledger)
      return initialState();
    return { ...parsed, actor: parsed.actor === "stranger" ? "stranger" : "owner" };
  } catch {
    return initialState();
  }
}

export function createStore() {
  let state = load();
  const listeners = new Set();

  const emit = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage can be blocked; the app still works for this session */
    }
    for (const listener of listeners) listener(state);
  };

  const actorAddress = () => (state.actor === "stranger" ? STRANGER_ADDRESS : state.owner);

  const api = {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actorAddress,
    actorLabel() {
      return state.actor === "stranger" ? "stranger" : "owner";
    },
    setActor(actor) {
      state = { ...state, actor: actor === "stranger" ? "stranger" : "owner" };
      emit();
    },
    reset() {
      state = initialState();
      emit();
    },

    summary(snapshot = state) {
      const list = Object.values(snapshot.assessments);
      return {
        policies: Object.keys(snapshot.policies).length,
        total: list.length,
        compliant: list.filter((a) => a.verdict === "COMPLIANT").length,
        non_compliant: list.filter((a) => a.verdict === "NON_COMPLIANT").length,
        review: list.filter((a) => a.verdict === "REVIEW").length,
        high_risk: list.filter((a) => a.risk_band === "HIGH").length,
      };
    },

    requireOwner() {
      if (actorAddress().toLowerCase() !== state.owner.toLowerCase())
        throw new ContractError("[EXPECTED]:unauthorized", "Only the contract owner can do that.");
    },

    registerPolicy({ policy_id, name, source_url, guidance }) {
      api.requireOwner();
      const id = normalizePolicyId(policy_id);
      if (state.policies[id]) throw new ContractError("[EXPECTED]:policy_exists", `Policy "${id}" is already registered.`);
      if (Object.keys(state.policies).length >= 100)
        throw new ContractError("[EXPECTED]:policy_limit", "This contract holds the maximum number of policies.");

      const cleanName = sanitize(name, 120);
      if (!cleanName) throw new ContractError("[EXPECTED]:empty_name", "A name is required.");

      const urlProblem = validateSourceUrl(source_url);
      if (urlProblem) throw new ContractError(`[EXPECTED]:${urlProblem}`, "The rules URL must be https on a public hostname.");

      const cleanGuidance = sanitize(guidance, 2000);
      if (!cleanGuidance) throw new ContractError("[EXPECTED]:empty_guidance", "Analyst guidance is required.");

      state = {
        ...state,
        policies: {
          ...state.policies,
          [id]: {
            policy_id: id,
            name: cleanName,
            source_url: String(source_url).trim(),
            guidance: cleanGuidance,
            rules: state.policies[id]?.rules || cleanGuidance,
            version: 1,
            active: true,
            assessments: 0,
          },
        },
      };
      emit();
      return id;
    },

    updatePolicy({ policy_id, name, source_url, guidance }) {
      api.requireOwner();
      const id = normalizePolicyId(policy_id);
      const policy = state.policies[id];
      if (!policy) throw new ContractError("[EXPECTED]:unknown_policy", "That policy does not exist.");
      if (policy.assessments > 0)
        throw new ContractError("[EXPECTED]:policy_locked", "This policy already produced assessments, so it is locked. Register a new one.");

      const urlProblem = validateSourceUrl(source_url);
      if (urlProblem) throw new ContractError(`[EXPECTED]:${urlProblem}`, "The rules URL must be https on a public hostname.");

      state = {
        ...state,
        policies: {
          ...state.policies,
          [id]: {
            ...policy,
            name: sanitize(name, 120),
            source_url: String(source_url).trim(),
            guidance: sanitize(guidance, 2000),
            version: policy.version + 1,
          },
        },
      };
      emit();
    },

    setPolicyActive(policy_id, active) {
      api.requireOwner();
      const policy = state.policies[policy_id];
      if (!policy) throw new ContractError("[EXPECTED]:unknown_policy", "That policy does not exist.");
      state = { ...state, policies: { ...state.policies, [policy_id]: { ...policy, active: Boolean(active) } } };
      emit();
    },

    transferOwnership(newOwner) {
      api.requireOwner();
      const candidate = String(newOwner ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(candidate))
        throw new ContractError("[EXPECTED]:invalid_address", "That is not a valid address.");
      if (candidate.toLowerCase() === ZERO) throw new ContractError("[EXPECTED]:zero_owner", "The zero address cannot own the contract.");
      state = { ...state, pendingOwner: candidate };
      emit();
    },

    acceptOwnership() {
      if (state.pendingOwner.toLowerCase() === ZERO)
        throw new ContractError("[EXPECTED]:no_pending_owner", "Nobody has been nominated.");
      if (actorAddress().toLowerCase() !== state.pendingOwner.toLowerCase())
        throw new ContractError("[EXPECTED]:not_pending_owner", "Only the nominated address can accept.");
      state = { ...state, owner: state.pendingOwner, pendingOwner: ZERO };
      emit();
    },

    assess({ policy_id, subject, counterparty, amount, context, submit_ref }) {
      const policy = state.policies[policy_id];
      if (!policy) throw new ContractError("[EXPECTED]:unknown_policy", "Choose a policy first.");
      if (!policy.active) throw new ContractError("[EXPECTED]:policy_inactive", "That policy is disabled.");
      if (state.summary().total >= 5000) throw new ContractError("[EXPECTED]:assessment_limit", "This contract has reached its assessment limit.");

      const cleanSubject = sanitize(subject, 160);
      if (!cleanSubject) throw new ContractError("[EXPECTED]:missing_subject", "A subject is required.");
      const cleanCounterparty = sanitize(counterparty, 160);
      const cleanAmount = sanitize(amount, 64);
      const cleanContext = sanitize(context, 600);

      const cleanRef = sanitize(submit_ref, 64);
      if (!cleanRef) throw new ContractError("[EXPECTED]:missing_submit_ref", "A submit reference is required.");

      const requester = actorAddress();
      const refKey = `${requester}|${cleanRef}`;
      if (state.submitRefs[refKey])
        throw new ContractError("[EXPECTED]:duplicate_submit", "That reference was already used by this caller. Regenerate it.");

      const form = { subject: cleanSubject, counterparty: cleanCounterparty, amount: cleanAmount, context: cleanContext };
      const decision = decide(policy, form);
      const id = `ca-${state.nextAssessmentId}`;

      const record = {
        assessment_id: id,
        policy_id,
        policy_version: policy.version,
        subject: cleanSubject,
        counterparty: cleanCounterparty,
        amount: cleanAmount,
        context: cleanContext,
        verdict: decision.verdict,
        risk_score: BAND_SCORE[decision.risk_level],
        risk_band: decision.risk_level,
        rule_quote: decision.rule_quote,
        rules_digest: digest(policy.rules || policy.guidance),
        findings: decision.grounded
          ? `Decided from ${policy.name}. The citation is grounded in the fetched rules.`
          : "Citation could not be grounded in the source. [citation could not be grounded in the source]",
        submit_ref: cleanRef,
        requester,
        created_at: new Date().toISOString(),
        consensus: {
          verdict: decision.verdict,
          risk_level: decision.risk_level,
          agree: true,
          rotations: decision.rotations,
          grounded: decision.grounded,
        },
      };

      state = {
        ...state,
        assessments: { ...state.assessments, [id]: record },
        submitRefs: { ...state.submitRefs, [refKey]: id },
        policies: { ...state.policies, [policy_id]: { ...policy, assessments: policy.assessments + 1 } },
        nextAssessmentId: state.nextAssessmentId + 1,
      };
      emit();
      return record;
    },

    createEscrow({ assessment_id, payee, amount, reference }) {
      const assessment = state.assessments[assessment_id];
      const requester = actorAddress();
      const wei = Math.max(0, Math.floor(Number(amount) || 0));
      const cleanPayee = String(payee ?? "").trim();

      let refusal = null;
      if (wei <= 0) throw new ContractError("[EXPECTED]:zero_deposit", "A deposit must be positive.");
      if (!assessment) refusal = "assessment_not_yours";
      else if (assessment.verdict !== "COMPLIANT") refusal = "assessment_not_compliant";
      else if (assessment.requester.toLowerCase() !== requester.toLowerCase()) refusal = "assessment_not_yours";
      else if (state.usedAssessments[assessment_id]) refusal = "assessment_already_used";

      let target = cleanPayee;
      if (!refusal) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(cleanPayee)) refusal = "invalid_payee";
        else if (cleanPayee.toLowerCase() === ZERO) refusal = "zero_payee";
        else if (cleanPayee.toLowerCase() === requester.toLowerCase()) refusal = "payee_is_funder";
      }

      const id = `esc-${state.nextEscrowId}`;
      const escrow = {
        escrow_id: id,
        funder: requester,
        payee: refusal ? ZERO : target,
        amount: wei,
        assessment_id: refusal ? "" : assessment_id,
        reference: sanitize(reference, 64),
        status: refusal ? "ORPHAN" : "FUNDED",
        created_ts: Math.floor(Date.now() / 1000),
        refusal,
      };

      state = {
        ...state,
        escrows: { ...state.escrows, [id]: escrow },
        usedAssessments: refusal ? state.usedAssessments : { ...state.usedAssessments, [assessment_id]: true },
        nextEscrowId: state.nextEscrowId + 1,
        ledger: {
          total_deposited: state.ledger.total_deposited + wei,
          total_out: state.ledger.total_out,
          locked_total: state.ledger.locked_total + wei,
        },
        balance: state.balance + wei,
      };
      emit();
      return escrow;
    },

    releaseEscrow(escrow_id) {
      const escrow = state.escrows[escrow_id];
      if (!escrow) throw new ContractError("[EXPECTED]:unknown_escrow", "That escrow does not exist.");
      if (escrow.status !== "FUNDED") throw new ContractError("[EXPECTED]:escrow_closed", "That escrow is already settled.");
      if (escrow.funder.toLowerCase() !== actorAddress().toLowerCase())
        throw new ContractError("[EXPECTED]:not_funder", "Only the funder can release this escrow.");

      state = {
        ...state,
        escrows: { ...state.escrows, [escrow_id]: { ...escrow, status: "RELEASED" } },
        ledger: {
          ...state.ledger,
          locked_total: state.ledger.locked_total - escrow.amount,
          total_out: state.ledger.total_out + escrow.amount,
        },
        balance: Math.max(0, state.balance - escrow.amount),
      };
      emit();
    },

    refundEscrow(escrow_id) {
      const escrow = state.escrows[escrow_id];
      if (!escrow) throw new ContractError("[EXPECTED]:unknown_escrow", "That escrow does not exist.");
      if (!["FUNDED", "ORPHAN"].includes(escrow.status))
        throw new ContractError("[EXPECTED]:escrow_closed", "That escrow is already settled.");

      const expired = Math.floor(Date.now() / 1000) >= Number(escrow.created_ts) + 30 * 86400;
      if (escrow.funder.toLowerCase() !== actorAddress().toLowerCase() && !expired)
        throw new ContractError("[EXPECTED]:not_funder", "Only the funder can refund this escrow.");

      state = {
        ...state,
        escrows: { ...state.escrows, [escrow_id]: { ...escrow, status: "REFUNDED" } },
        ledger: {
          ...state.ledger,
          locked_total: state.ledger.locked_total - escrow.amount,
          total_out: state.ledger.total_out + escrow.amount,
        },
        balance: Math.max(0, state.balance - escrow.amount),
      };
      emit();
    },

    isEscrowExpired(escrow) {
      return Math.floor(Date.now() / 1000) >= Number(escrow.created_ts) + 30 * 86400;
    },

    ledgerOk(snapshot = state) {
      const { total_deposited, total_out, locked_total } = snapshot.ledger;
      return total_deposited === total_out + locked_total;
    },
  };

  return api;
}
