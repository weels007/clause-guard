/** ClauseGuard store.
 *
 * Two backends behind one API:
 *  - "chain": reads through genlayer-js from the deployed contract, writes and
 *    deploys signed by the connected wallet (see chain.js).
 *  - "sim": the deterministic stand-in mirroring contracts/ClauseGuard.py, used
 *    when no contract address is configured.
 *
 * Every mutator is async, so a page can `await` the same call in both modes
 * (awaiting a plain value is harmless).
 */
import { useSyncExternalStore } from "react";
import { DEMO_ASSESSMENTS, DEMO_ESCROWS, DEMO_POLICIES, OWNER_ADDRESS, STRANGER_ADDRESS } from "./data.js";
import { consensusOf, deployContract, readView, receiptError, sendWrite, succeeded } from "./chain.js";

export class ContractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const STORAGE_KEY = "clauseguard.sim.v2";
const ADDRESS_KEY = "clauseguard.contract.v1";
const ZERO = "0x" + "0".repeat(40);
const BAND_SCORE = { LOW: 20, MEDIUM: 50, HIGH: 80 };
const POLICY_ID_ALPHABET = /^[a-z0-9._-]+$/;

const ERROR_TEXT = {
  unauthorized: "Only the contract owner can do that.",
  wallet_required: "Connect an EVM wallet first.",
  unknown_contract: "No contract address is configured yet.",
  policy_exists: "That policy id is already registered.",
  policy_limit: "The contract has reached its policy limit.",
  empty_policy_id: "A policy id is required.",
  invalid_policy_id: "Use lowercase letters, digits and - _ . only.",
  policy_id_too_long: "That policy id is too long.",
  empty_name: "A name is required.",
  empty_guidance: "Analyst guidance is required.",
  invalid_source_url: "The rules URL must be https on a public hostname.",
  source_url_too_long: "That URL is too long.",
  unknown_policy: "That policy does not exist.",
  policy_inactive: "That policy is disabled.",
  policy_locked: "This policy already produced assessments, so it is locked. Register a new one.",
  missing_subject: "A subject is required.",
  missing_submit_ref: "A submit reference is required.",
  duplicate_submit: "That reference was already used by this caller. Regenerate it.",
  assessment_limit: "The contract has reached its assessment limit.",
  zero_deposit: "A deposit must be positive.",
  unknown_escrow: "That escrow does not exist.",
  escrow_locked: "That escrow cannot be moved right now.",
  escrow_closed: "That escrow is already settled.",
  escrow_not_held: "The contract no longer holds that deposit.",
  not_funder: "Only the funder can move this escrow.",
  zero_owner: "The zero address cannot own the contract.",
  no_pending_owner: "Nobody has been nominated to take over.",
  not_pending_owner: "Only the nominated address can accept.",
  invalid_address: "That is not a valid address.",
  invalid_payee: "That payee address is not valid.",
  zero_payee: "The payee cannot be the zero address.",
  payee_is_funder: "The payee cannot be the funder.",
  unknown_assessment: "That assessment does not exist.",
  assessment_not_compliant: "Only a COMPLIANT assessment can back an escrow.",
  assessment_not_yours: "Only the account that ran the assessment can fund it.",
  assessment_already_used: "That assessment already backs an escrow.",
  undetermined: "Validators did not reach consensus, so nothing was written.",
};

export function humanizeError(error) {
  if (!error) return "Something went wrong.";
  const code = String(error.code || "").replace(/^\[[A-Z_]+\]:/, "");
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  return error.message || "Something went wrong.";
}

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

/** Pick a whole, long enough sentence that supports the verdict. */
function pickQuote(rules, keywords, verdict) {
  const candidates = (String(rules || "").match(/[^.!?]+[.!?]*/g) || [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.replace(/[^a-z0-9]/gi, "").length >= 20);
  if (!candidates.length) return "";

  const lowered = keywords.toLowerCase();
  const restrictive = /prohibit|refused|must not|denied|not allowed/i;

  const scored = candidates.map((sentence) => {
    const hits = sentence
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 4)
      .filter((word) => lowered.includes(word)).length;
    const polarity =
      verdict === "COMPLIANT"
        ? restrictive.test(sentence)
          ? 0
          : 1
        : verdict === "NON_COMPLIANT"
          ? restrictive.test(sentence)
            ? 1
            : 0
          : 0;
    return { sentence, score: hits * 2 + polarity };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].sentence.slice(0, 240);
}

/** Rules like "transfers above 10000 EUR … are prohibited" carry a real
 *  threshold; read it so the fallback verdict follows the rule it quotes. */
function extractThreshold(rules) {
  const match = String(rules || "").match(
    /(?:above|over|more than|exceeds|exceeding)\s+([\d][\d,]*(?:\.\d+)?)\s*([A-Z]{2,5})?/i
  );
  if (!match) return null;
  return { value: Number(match[1].replace(/,/g, "")), currency: (match[2] || "").toUpperCase() };
}

function parseAmount(amount) {
  const match = String(amount || "").match(/([\d][\d,]*(?:\.\d+)?)\s*([A-Z]{2,5})?/i);
  if (!match) return null;
  return { value: Number(match[1].replace(/,/g, "")), currency: (match[2] || "").toUpperCase() };
}

/** A deterministic stand-in for the committee: same inputs, same verdict. */
function decide(policy, form) {
  const rules = policy.rules || "";
  const haystack = `${form.subject} ${form.counterparty} ${form.amount} ${form.context}`.toLowerCase();
  const roll = hash(`${policy.policy_id}|${haystack}`) % 100;

  const sanctions = /sanction|ofac|blocked|denied/.test(haystack);
  const prohibitedRules = /prohibit|prohibited|refused|must be refused/.test(rules);

  const threshold = extractThreshold(rules);
  const amount = parseAmount(form.amount);
  const comparable =
    threshold &&
    amount &&
    (!threshold.currency || !amount.currency || threshold.currency === amount.currency);

  let verdict;
  let level;
  if (sanctions && prohibitedRules) {
    verdict = "NON_COMPLIANT";
    level = "HIGH";
  } else if (comparable) {
    if (amount.value > threshold.value) {
      verdict = "NON_COMPLIANT";
      level = "HIGH";
    } else {
      verdict = "COMPLIANT";
      /* Right under the line is the risky side of compliant. */
      level = amount.value >= threshold.value * 0.9 ? "MEDIUM" : "LOW";
    }
  } else if (roll < 62) {
    verdict = "COMPLIANT";
    level = roll % 2 === 0 ? "LOW" : "MEDIUM";
  } else if (roll < 84) {
    verdict = "REVIEW";
    level = "MEDIUM";
  } else {
    verdict = "NON_COMPLIANT";
    level = "HIGH";
  }

  const quote = pickQuote(rules, haystack, verdict);
  const quoteFolded = quote.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rulesFolded = rules.toLowerCase().replace(/[^a-z0-9]/g, "");
  const grounded = quoteFolded.length >= 20 && rulesFolded.includes(quoteFolded);

  return {
    verdict: grounded ? verdict : "REVIEW",
    risk_level: grounded ? level : "MEDIUM",
    rule_quote: grounded ? quote : "",
    grounded,
    rotations: grounded ? roll % 3 : 1,
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
    submitRefs: {},
    nextAssessmentId: 4,
    nextEscrowId: 2,
    ledger: { total_deposited: 1000, total_out: 0, locked_total: 1000 },
    balance: 1000,
    actor: "owner",
    wallet: { address: null, name: "", rdns: "" },
  };
}

function loadSim() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.policies || !parsed.assessments || !parsed.escrows || !parsed.ledger)
      return initialState();
    const wallet = parsed.wallet && typeof parsed.wallet === "object" ? parsed.wallet : {};
    return {
      ...parsed,
      actor: parsed.actor === "stranger" ? "stranger" : "owner",
      wallet: {
        address: typeof wallet.address === "string" ? wallet.address : null,
        name: typeof wallet.name === "string" ? wallet.name : "",
        rdns: typeof wallet.rdns === "string" ? wallet.rdns : "",
      },
    };
  } catch {
    return initialState();
  }
}

/* ── simulator ────────────────────────────────────────────────── */

function createSimulator() {
  let state = loadSim();
  const listeners = new Set();

  const emit = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage can be blocked; the app still works for this session */
    }
    for (const listener of listeners) listener();
  };

  const actorAddress = () =>
    state.wallet?.address || (state.actor === "stranger" ? STRANGER_ADDRESS : state.owner);

  const requireOwner = () => {
    if (actorAddress().toLowerCase() !== state.owner.toLowerCase())
      throw new ContractError("[EXPECTED]:unauthorized", "Only the contract owner can do that.");
  };

  const api = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    actorAddress,
    isOwner: () => actorAddress().toLowerCase() === state.owner.toLowerCase(),

    setActor(actor) {
      if (state.wallet?.address) return;
      state = { ...state, actor: actor === "stranger" ? "stranger" : "owner" };
      emit();
    },

    setWallet({ address, name, rdns }) {
      const candidate = String(address ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(candidate)) return;
      state = {
        ...state,
        wallet: {
          address: candidate,
          name: name || state.wallet?.name || "Wallet",
          rdns: rdns ?? state.wallet?.rdns ?? "",
        },
      };
      emit();
    },

    clearWallet() {
      state = { ...state, wallet: { address: null, name: "", rdns: "" } };
      emit();
    },

    reset() {
      state = { ...initialState(), wallet: state.wallet };
      emit();
    },

    registerPolicy({ policy_id, name, source_url, guidance }) {
      requireOwner();
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
      requireOwner();
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
      requireOwner();
      const policy = state.policies[policy_id];
      if (!policy) throw new ContractError("[EXPECTED]:unknown_policy", "That policy does not exist.");
      state = { ...state, policies: { ...state.policies, [policy_id]: { ...policy, active: Boolean(active) } } };
      emit();
    },

    transferOwnership(newOwner) {
      requireOwner();
      const candidate = String(newOwner ?? "").trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(candidate))
        throw new ContractError("[EXPECTED]:invalid_address", "That is not a valid address.");
      if (candidate.toLowerCase() === ZERO)
        throw new ContractError("[EXPECTED]:zero_owner", "The zero address cannot own the contract.");
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
      if (Object.keys(state.assessments).length >= 5000)
        throw new ContractError("[EXPECTED]:assessment_limit", "This contract has reached its assessment limit.");

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

      if (!refusal) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(cleanPayee)) refusal = "invalid_payee";
        else if (cleanPayee.toLowerCase() === ZERO) refusal = "zero_payee";
        else if (cleanPayee.toLowerCase() === requester.toLowerCase()) refusal = "payee_is_funder";
      }

      const id = `esc-${state.nextEscrowId}`;
      const escrow = {
        escrow_id: id,
        funder: requester,
        payee: refusal ? ZERO : cleanPayee,
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
  };

  return api;
}

/* ── facade: chain when an address is set, simulator otherwise ─── */

export function loadAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) || "";
  } catch {
    return "";
  }
}

function saveAddress(address) {
  try {
    if (address) localStorage.setItem(ADDRESS_KEY, address);
    else localStorage.removeItem(ADDRESS_KEY);
  } catch {
    /* storage can be blocked; the session still works */
  }
}

const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value ?? "").trim());
const idNumber = (value) => Number(String(value ?? "").replace(/[^0-9]/g, "")) || 0;

export function createContract() {
  const sim = createSimulator();
  const listeners = new Set();

  let address = loadAddress();
  let chainData = null;
  let provider = null;
  let tx = null;
  let chainError = "";
  let loading = false;

  const isChain = () => Boolean(address);

  function compose() {
    const simState = sim.getState();
    if (!isChain()) {
      return { ...simState, mode: "sim", address: "", loading, tx, chainError };
    }
    const escrows = chainData?.escrows || {};
    const usedAssessments = {};
    for (const escrow of Object.values(escrows)) {
      if (escrow.assessment_id) usedAssessments[escrow.assessment_id] = true;
    }
    return {
      owner: chainData?.owner || "",
      pendingOwner: chainData?.pendingOwner || ZERO,
      policies: chainData?.policies || {},
      assessments: chainData?.assessments || {},
      escrows,
      usedAssessments,
      submitRefs: {},
      nextAssessmentId: 0,
      nextEscrowId: 0,
      ledger: chainData?.ledger || { total_deposited: 0, total_out: 0, locked_total: 0 },
      balance: chainData?.balance ?? 0,
      actor: "owner",
      wallet: simState.wallet,
      mode: "chain",
      address,
      loading,
      tx,
      chainError,
    };
  }

  let state = compose();
  const emit = () => listeners.forEach((listener) => listener());

  const sync = () => {
    state = compose();
    emit();
  };

  sim.subscribe(sync);

  const wallet = () => {
    const saved = sim.getState().wallet;
    if (!saved?.address) throw new ContractError("[EXPECTED]:wallet_required", "Connect an EVM wallet first.");
    if (!provider) throw new ContractError("[EXPECTED]:wallet_required", "Reconnect the wallet: the page lost its provider.");
    return saved;
  };

  const actorAddress = () => (isChain() ? sim.getState().wallet?.address || "" : sim.actorAddress());

  async function refresh() {
    if (!isChain()) return;
    loading = true;
    sync();
    try {
      const [owner, pendingOwner, policies, assessments, escrows, ledger, balance] = await Promise.all([
        readView(address, "get_owner"),
        readView(address, "get_pending_owner"),
        readView(address, "get_policies"),
        readView(address, "get_assessments"),
        readView(address, "get_escrows"),
        readView(address, "get_ledger"),
        readView(address, "get_balance"),
      ]);
      chainData = {
        owner: String(owner || ""),
        pendingOwner: String(pendingOwner || ZERO),
        policies: policies || {},
        assessments: assessments || {},
        escrows: escrows || {},
        ledger: {
          total_deposited: Number(ledger?.total_deposited || 0),
          total_out: Number(ledger?.total_out || 0),
          locked_total: Number(ledger?.locked_total || 0),
        },
        balance: Number(balance || 0),
      };
      chainError = "";
    } catch (error) {
      chainError = error?.message || String(error);
    } finally {
      loading = false;
      sync();
    }
  }

  function setAddress(next) {
    const clean = String(next ?? "").trim();
    if (!isAddress(clean)) throw new ContractError("[EXPECTED]:invalid_address", "That is not a valid contract address.");
    address = clean;
    chainData = null;
    tx = null;
    chainError = "";
    saveAddress(clean);
    sync();
    refresh();
  }

  function clearAddress() {
    address = "";
    chainData = null;
    tx = null;
    chainError = "";
    saveAddress("");
    sync();
  }

  async function chainWrite(functionName, args, value = 0) {
    if (!isChain()) throw new ContractError("[EXPECTED]:unknown_contract", "No contract address is configured yet.");
    const saved = wallet();
    tx = { stage: "signing", functionName };
    chainError = "";
    sync();
    try {
      const result = await sendWrite({
        address,
        account: saved.address,
        provider,
        functionName,
        args,
        value,
        onHash: (hash) => {
          tx = { stage: "submitted", hash, functionName };
          sync();
        },
      });
      const consensus = consensusOf(result.receipt);
      if (!succeeded(result.receipt)) {
        const failure = receiptError(result.receipt);
        tx = { stage: "failed", hash: result.hash, consensus, functionName };
        chainError = failure.message;
        sync();
        throw new ContractError(failure.code || "[EXPECTED]:reverted", failure.message);
      }
      tx = { stage: "accepted", hash: result.hash, consensus, functionName };
      sync();
      await refresh();
      return result;
    } catch (error) {
      if (tx && tx.stage === "signing") {
        tx = { stage: "failed", functionName, error: error?.message || String(error) };
        sync();
      }
      throw error;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isChain,
    get address() {
      return address;
    },
    setProvider(next) {
      provider = next || null;
    },
    refresh,
    deploy: async () => {
      const saved = wallet();
      tx = { stage: "deploying" };
      chainError = "";
      sync();
      const result = await deployContract({
        account: saved.address,
        provider,
        onHash: (hash) => {
          tx = { stage: "deploying", hash };
          sync();
        },
      });
      if (!succeeded(result.receipt)) {
        const failure = receiptError(result.receipt);
        tx = { stage: "failed", consensus: consensusOf(result.receipt) };
        chainError = failure.message;
        sync();
        throw new ContractError(failure.code || "[EXPECTED]:deploy_failed", failure.message);
      }
      if (!result.address) {
        const failure = new ContractError("[EXPECTED]:unknown_contract", "Deployed, but the receipt did not carry the address.");
        chainError = failure.message;
        sync();
        throw failure;
      }
      tx = { stage: "deployed", hash: result.hash };
      setAddress(result.address);
      return result.address;
    },
    setAddress,
    clearAddress,

    actorAddress,
    isOwner: () => {
      const me = actorAddress();
      return Boolean(me) && Boolean(state.owner) && me.toLowerCase() === state.owner.toLowerCase();
    },

    setActor(actor) {
      if (isChain()) return;
      sim.setActor(actor);
    },
    setWallet(payload) {
      sim.setWallet(payload);
    },
    clearWallet() {
      sim.clearWallet();
    },
    reset() {
      if (!isChain()) sim.reset();
    },

    summary(snapshot = state) {
      const list = Object.values(snapshot.assessments || {});
      return {
        policies: Object.keys(snapshot.policies || {}).length,
        total: list.length,
        compliant: list.filter((a) => a.verdict === "COMPLIANT").length,
        non_compliant: list.filter((a) => a.verdict === "NON_COMPLIANT").length,
        review: list.filter((a) => a.verdict === "REVIEW").length,
        high_risk: list.filter((a) => a.risk_band === "HIGH").length,
      };
    },

    ledgerOk: (snapshot = state) =>
      Number(snapshot.ledger?.total_deposited || 0) ===
      Number(snapshot.ledger?.total_out || 0) + Number(snapshot.ledger?.locked_total || 0),

    isEscrowExpired: (escrow) => Math.floor(Date.now() / 1000) >= Number(escrow.created_ts) + 30 * 86400,

    async registerPolicy(payload) {
      if (!isChain()) return sim.registerPolicy(payload);
      await chainWrite("register_policy", [payload.policy_id, payload.name, payload.source_url, payload.guidance]);
    },

    async updatePolicy(payload) {
      if (!isChain()) return sim.updatePolicy(payload);
      await chainWrite("update_policy", [payload.policy_id, payload.name, payload.source_url, payload.guidance]);
    },

    async setPolicyActive(policyId, active) {
      if (!isChain()) return sim.setPolicyActive(policyId, active);
      await chainWrite("set_policy_active", [policyId, Boolean(active)]);
    },

    async transferOwnership(newOwner) {
      if (!isChain()) return sim.transferOwnership(newOwner);
      await chainWrite("transfer_ownership", [String(newOwner ?? "").trim()]);
    },

    async acceptOwnership() {
      if (!isChain()) return sim.acceptOwnership();
      await chainWrite("accept_ownership", []);
    },

    async assess(form) {
      if (!isChain()) return sim.assess(form);
      await chainWrite("assess", [
        form.policy_id,
        form.subject || "",
        form.counterparty || "",
        form.amount || "",
        form.context || "",
        form.submit_ref,
      ]);
      const me = String(sim.getState().wallet?.address || "").toLowerCase();
      const matches = Object.values(state.assessments)
        .filter((record) => String(record.submit_ref) === String(form.submit_ref) && String(record.requester).toLowerCase() === me)
        .sort((a, b) => idNumber(b.assessment_id) - idNumber(a.assessment_id));
      return matches[0] || null;
    },

    async createEscrow(form) {
      if (!isChain()) return sim.createEscrow(form);
      const wei = Math.max(0, Math.floor(Number(form.amount) || 0));
      await chainWrite("create_escrow", [form.assessment_id, form.payee, form.reference || ""], wei);
      const me = String(sim.getState().wallet?.address || "").toLowerCase();
      const mine = Object.values(state.escrows)
        .filter((escrow) => String(escrow.funder).toLowerCase() === me)
        .sort((a, b) => idNumber(b.escrow_id) - idNumber(a.escrow_id));
      return mine[0] || null;
    },

    async releaseEscrow(escrowId) {
      if (!isChain()) return sim.releaseEscrow(escrowId);
      await chainWrite("release_escrow", [escrowId]);
    },

    async refundEscrow(escrowId) {
      if (!isChain()) return sim.refundEscrow(escrowId);
      await chainWrite("refund_escrow", [escrowId]);
    },
  };
}

export function useContract(contract) {
  return useSyncExternalStore(contract.subscribe, contract.getState, contract.getState);
}
