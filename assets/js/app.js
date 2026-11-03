import { STRANGER_ADDRESS } from "./data.js";
import { ContractError, createStore } from "./store.js";
import {
  armReveals,
  escapeHtml,
  formatWei,
  humanizeError,
  newSubmitRef,
  shortAddress,
  statusPill,
  toast,
  withBusy,
} from "./ui.js";
import {
  connectProvider,
  discoverWallets,
  findWallet,
  GENLAYER_CHAIN,
  GENLAYER_CHAIN_ID,
  walletErrorMessage,
} from "./wallet.js";

const store = createStore();
const ROUTES = {
  "/": "landing",
  "/dashboard": "dashboard",
  "/policies": "policies",
  "/assess": "assess",
  "/escrows": "escrows",
  "/how": "how",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function currentRoute() {
  const path = (location.hash || "#/").replace(/^#/, "") || "/";
  return ROUTES[path] || "landing";
}

/* ── chrome ───────────────────────────────────────────────────────────── */

function setupChrome() {
  const toggle = $("#menu-toggle");
  const menu = $("#mobile-menu");

  toggle?.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });

  $$("#mobile-menu a").forEach((link) =>
    link.addEventListener("click", () => {
      menu.hidden = true;
      toggle?.setAttribute("aria-expanded", "false");
    })
  );

  const actorButton = $("#actor-switch");
  actorButton?.addEventListener("click", () => {
    if (store.state.wallet?.address) return;
    const next = store.state.actor === "owner" ? "stranger" : "owner";
    store.setActor(next);
    toast("ok", "Acting as " + next, next === "owner" ? "You now sign as the contract owner." : "You now sign as the stranger, to test the guards.");
  });

  $("#wallet-button")?.addEventListener("click", openWalletModal);
  $("#wallet-close")?.addEventListener("click", closeWalletModal);
  $("#wallet-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeWalletModal();
  });

  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action) return;
    const { action: name, id } = action.dataset;
    if (name === "wallet-pick") {
      const picked = discoveredWallets.find((wallet) => wallet.uuid === action.dataset.uuid);
      connectWallet(picked);
      return;
    }
    if (name === "wallet-disconnect") {
      disconnectWallet();
      closeWalletModal();
      return;
    }
    if (name === "reset-demo") {
      if (!window.confirm("Reset the simulated contract to its seeded state?")) return;
      store.reset();
      toast("ok", "Reset", "The simulated contract is back to its seeded state.");
      return;
    }
    if (name === "policy-edit") startPolicyEdit(id);
    if (name === "policy-toggle") togglePolicy(id, action.dataset.active === "true");
    if (name === "escrow-release") settleEscrow(id, "release");
    if (name === "escrow-refund") settleEscrow(id, "refund");
    if (name === "new-escrow") openEscrowForm();
    if (name === "close-escrow-form") closeEscrowForm();
    if (name === "new-ref") {
      const input = $("#submit-ref");
      if (input) input.value = newSubmitRef();
    }
    if (name === "accept-ownership") {
      try {
        store.acceptOwnership();
        toast("ok", "Ownership moved", "You are now the contract owner.");
      } catch (error) {
        toast("error", "Ownership not accepted", humanizeError(error));
      }
    }
  });

  const policyForm = $("#policy-form");
  policyForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitPolicyForm(policyForm);
  });

  $("#policy-cancel")?.addEventListener("click", () => resetPolicyForm());

  $("#assess-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runAssessment(event.currentTarget);
  });

  const escrowForm = $("#escrow-form");
  escrowForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitEscrowForm(escrowForm);
  });

  $("#new-escrow")?.addEventListener("click", openEscrowForm);
  $("#close-escrow-form")?.addEventListener("click", closeEscrowForm);

  store.subscribe(() => render());
}

function syncActorChrome() {
  const label = $("#actor-label");
  const button = $("#actor-switch");
  const isStranger = store.state.actor === "stranger";
  if (label) label.textContent = isStranger ? "stranger" : "owner";
  if (button) button.dataset.actor = isStranger ? "stranger" : "owner";
  if (button) button.title = isStranger ? `Signing as ${STRANGER_ADDRESS}` : "Signing as the contract owner";
}

/* ── wallet ───────────────────────────────────────────────────────────── */

let discoveredWallets = [];
let activeProvider = null;
let detachedAccounts = null;
let detachedChain = null;

function openWalletModal() {
  const modal = $("#wallet-modal");
  if (!modal) return;

  const list = $("#wallet-list");
  const empty = $("#wallet-empty");
  const foot = $("#wallet-foot");
  const errorBox = $("#wallet-error");
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  if (empty) empty.hidden = true;
  if (foot) foot.hidden = !store.state.wallet?.address;
  if (list) list.innerHTML = `<li class="wallet-loading">Looking for installed wallets…</li>`;

  if (typeof modal.showModal === "function") {
    if (!modal.open) modal.showModal();
  } else {
    modal.setAttribute("open", "");
  }

  discoverWallets().then((wallets) => {
    discoveredWallets = wallets;
    renderWalletList();
  });
}

function closeWalletModal() {
  const modal = $("#wallet-modal");
  if (!modal) return;
  if (typeof modal.close === "function" && modal.open) modal.close();
  else modal.removeAttribute("open");
}

function renderWalletList() {
  const list = $("#wallet-list");
  const empty = $("#wallet-empty");
  const foot = $("#wallet-foot");
  if (!list) return;
  if (foot) foot.hidden = !store.state.wallet?.address;

  if (!discoveredWallets.length) {
    list.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  list.innerHTML = discoveredWallets
    .map(
      (wallet) => `
      <li>
        <button class="wallet-item" type="button" data-action="wallet-pick" data-uuid="${escapeHtml(wallet.uuid)}">
          ${
            wallet.icon
              ? `<img class="wallet-icon" src="${escapeHtml(wallet.icon)}" alt="" width="28" height="28" />`
              : `<span class="wallet-icon wallet-icon-empty" aria-hidden="true"></span>`
          }
          <span class="wallet-meta">
            <span class="wallet-name">${escapeHtml(wallet.name)}</span>
            ${wallet.rdns ? `<span class="wallet-rdns">${escapeHtml(wallet.rdns)}</span>` : ""}
          </span>
          <span class="wallet-go" aria-hidden="true">→</span>
        </button>
      </li>`
    )
    .join("");
}

async function connectWallet(wallet) {
  if (!wallet) return;
  const errorBox = $("#wallet-error");
  const esc = window.CSS && CSS.escape ? CSS.escape(wallet.uuid) : wallet.uuid;
  const button = document.querySelector(`.wallet-item[data-uuid="${esc}"]`);

  const result = await withBusy(button, async () => {
    try {
      return await connectProvider(wallet.provider);
    } catch (error) {
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = walletErrorMessage(error);
      }
      return null;
    }
  });

  if (!result) return;

  attachWalletListeners(wallet.provider, wallet);
  store.setWallet({ address: result.address, name: wallet.name, rdns: wallet.rdns });
  closeWalletModal();

  if (!result.onChain) {
    toast(
      "error",
      "Wrong network",
      `Your wallet is on chain ${result.chainId}. Switch it to GenLayer Studio Network (${GENLAYER_CHAIN_ID}) to transact.`
    );
    return;
  }
  toast(
    "ok",
    `Connected: ${wallet.name}`,
    `${shortAddress(result.address)} · GenLayer Studio Network (${GENLAYER_CHAIN_ID}).`
  );
}

function attachWalletListeners(provider, wallet) {
  if (activeProvider && activeProvider !== provider) detachWalletListeners();
  activeProvider = provider;

  detachedAccounts = (accounts) => {
    if (!Array.isArray(accounts) || !accounts.length) {
      disconnectWallet(true);
      return;
    }
    const next = accounts[0];
    const current = store.state.wallet?.address;
    if (current && current.toLowerCase() === String(next).toLowerCase()) return;
    store.setWallet({
      address: next,
      name: store.state.wallet?.name || wallet?.name || "Wallet",
      rdns: store.state.wallet?.rdns || wallet?.rdns || "",
    });
    toast("ok", "Account switched", shortAddress(next));
  };

  detachedChain = (chainId) => {
    if (String(chainId).toLowerCase() === GENLAYER_CHAIN.chainId) {
      toast("ok", "Network ready", `GenLayer Studio Network (${GENLAYER_CHAIN_ID}).`);
    } else {
      toast("error", "Wrong network", `Switch your wallet to GenLayer Studio Network (${GENLAYER_CHAIN_ID}).`);
    }
  };

  provider.removeListener?.("accountsChanged", detachedAccounts);
  provider.removeListener?.("chainChanged", detachedChain);
  provider.on?.("accountsChanged", detachedAccounts);
  provider.on?.("chainChanged", detachedChain);
}

function detachWalletListeners() {
  if (!activeProvider) return;
  activeProvider.removeListener?.("accountsChanged", detachedAccounts);
  activeProvider.removeListener?.("chainChanged", detachedChain);
  activeProvider = null;
  detachedAccounts = null;
  detachedChain = null;
}

function disconnectWallet(silent = false) {
  detachWalletListeners();
  const wasConnected = Boolean(store.state.wallet?.address);
  store.clearWallet();
  if (!silent && wasConnected) toast("ok", "Wallet disconnected", "Back to the demo accounts.");
}

/* Silent reconnect after a reload: the provider is gone, but the choice is not. */
async function restoreWallet() {
  const wallet = store.state.wallet;
  if (!wallet?.address) return;

  let match = null;
  try {
    match = await findWallet(wallet.rdns, wallet.name);
  } catch {
    match = null;
  }
  if (!match) return;

  try {
    const accounts = await match.provider.request({ method: "eth_accounts" });
    const stillThere =
      Array.isArray(accounts) && accounts.some((account) => String(account).toLowerCase() === wallet.address.toLowerCase());
    if (!stillThere) {
      store.clearWallet();
      return;
    }
    attachWalletListeners(match.provider, match);
    store.setWallet({ address: wallet.address, name: wallet.name || match.name, rdns: wallet.rdns || match.rdns });
  } catch {
    store.clearWallet();
  }
}

function syncWalletChrome() {
  const button = $("#wallet-button");
  const label = $("#wallet-label");
  const actorSwitch = $("#actor-switch");
  const wallet = store.state.wallet || {};
  const connected = Boolean(wallet.address);

  if (button) {
    button.dataset.connected = connected ? "true" : "false";
    button.title = connected ? `${wallet.name || "Wallet"} · ${wallet.address}` : "Connect an EVM wallet";
  }
  if (label) {
    label.textContent = connected ? `${wallet.name || "Wallet"} · ${shortAddress(wallet.address)}` : "Connect wallet";
  }
  if (actorSwitch) actorSwitch.hidden = connected;
}

function renderWalletNote() {
  const note = $("#wallet-note");
  if (!note) return;
  const connected = Boolean(store.state.wallet?.address);
  const owner = store.isOwner();
  note.hidden = !connected || owner;
  if (note.hidden) return;
  note.textContent = `Your wallet (${shortAddress(
    store.actorAddress()
  )}) is not the contract owner, so policy writes will be refused. Disconnect, or act as the demo owner, to register policies.`;
}

/* ── router ───────────────────────────────────────────────────────────── */

function render() {
  const route = currentRoute();

  $$("[data-view]").forEach((section) => {
    section.hidden = section.dataset.view !== route;
  });

  $$("[data-nav]").forEach((link) => {
    const target = ROUTES[(link.getAttribute("href") || "").slice(1)] || "landing";
    if (target === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  syncActorChrome();
  syncWalletChrome();

  if (route === "landing") renderLanding();
  if (route === "dashboard") renderDashboard();
  if (route === "policies") renderPolicies();
  if (route === "assess") renderAssess();
  if (route === "escrows") renderEscrows();

  armReveals();
  document.title =
    route === "landing"
      ? "ClauseGuard — compliance verdicts you can audit"
      : `ClauseGuard — ${route.charAt(0).toUpperCase() + route.slice(1)}`;
}

window.addEventListener("hashchange", () => {
  /* Jump, don't animate: html{scroll-behavior:smooth} would glide from the old
     position across a layout that has already been swapped out. */
  const root = document.documentElement;
  const previous = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo(0, 0);
  render();
  root.style.scrollBehavior = previous;
});

/* ── landing ──────────────────────────────────────────────────────────── */

function renderLanding() {
  const summary = store.summary();
  const values = {
    policies: summary.policies,
    total: summary.total,
    review: summary.review,
    locked: formatWei(store.state.ledger.locked_total),
  };
  $$("[data-stat]").forEach((node) => {
    const value = values[node.dataset.stat];
    node.textContent = value === undefined ? "—" : String(value);
  });
}

/* ── dashboard ────────────────────────────────────────────────────────── */

function renderDashboard() {
  const summary = store.summary();
  const grid = $("#stat-grid");
  if (grid) {
    const cards = [
      ["policies", summary.policies],
      ["assessments", summary.total],
      ["compliant", summary.compliant],
      ["non-compliant", summary.non_compliant],
      ["for review", summary.review],
      ["high risk", summary.high_risk],
    ];
    grid.innerHTML = cards
      .map(
        ([label, value]) =>
          `<div class="stat"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
      )
      .join("");
  }

  const ledger = store.state.ledger;
  const ok = store.ledgerOk();
  const ledgerState = $("#ledger-state");
  if (ledgerState) {
    ledgerState.textContent = ok ? "balanced" : "mismatch";
    ledgerState.className = `pill ${ok ? "ok" : "bad"}`;
  }
  const kv = $("#ledger-kv");
  if (kv) {
    kv.innerHTML = [
      ["total deposited", formatWei(ledger.total_deposited)],
      ["total out", formatWei(ledger.total_out)],
      ["locked total", formatWei(ledger.locked_total)],
      ["contract balance", formatWei(store.state.balance)],
      ["owner", shortAddress(store.state.owner)],
      ["pending owner", store.state.pendingOwner === "0x" + "0".repeat(40) ? "none" : shortAddress(store.state.pendingOwner)],
    ]
      .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("");
  }

  const recent = $("#recent-assessments");
  if (recent) {
    const records = Object.values(store.state.assessments)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 6);
    recent.innerHTML = records.length
      ? records
          .map(
            (record) => `
        <li class="list-item">
          <div class="list-main">
            <div class="list-title">${escapeHtml(record.subject || "—")} → ${escapeHtml(record.counterparty || "—")}</div>
            <div class="list-sub">${escapeHtml(record.policy_id)} · ${escapeHtml(record.amount || "no amount")} · ${escapeHtml(record.assessment_id)}</div>
          </div>
          <div class="list-side">
            <span class="chip ${record.verdict === "COMPLIANT" ? "chip-compliant" : record.verdict === "NON_COMPLIANT" ? "chip-non-compliant" : "chip-review"}">${escapeHtml(record.verdict)}</span>
          </div>
        </li>`
          )
          .join("")
      : `<li class="empty">No assessments yet.</li>`;
  }
}

/* ── policies ─────────────────────────────────────────────────────────── */

let editingPolicyId = null;

function renderPolicies() {
  const list = $("#policy-list");
  const policies = Object.values(store.state.policies).sort((a, b) =>
    a.policy_id.localeCompare(b.policy_id)
  );
  const count = $("#policy-count");
  if (count) count.textContent = `${policies.length}/100`;

  if (list) {
    list.innerHTML = policies.length
      ? policies
          .map(
            (policy) => `
        <li class="list-item">
          <div class="list-main">
            <div class="list-title">${escapeHtml(policy.name)}</div>
            <div class="list-sub mono">${escapeHtml(policy.policy_id)} · v${escapeHtml(policy.version)} · ${escapeHtml(policy.assessments)} assessments</div>
          </div>
          <div class="list-side">
            <span class="pill ${policy.active ? "ok" : ""}">${policy.active ? "active" : "off"}</span>
            <button class="btn btn-ghost btn-sm" type="button" data-action="policy-toggle" data-id="${escapeHtml(policy.policy_id)}" data-active="${policy.active}">${policy.active ? "Disable" : "Enable"}</button>
            ${
              policy.assessments === 0
                ? `<button class="btn btn-ghost btn-sm" type="button" data-action="policy-edit" data-id="${escapeHtml(policy.policy_id)}">Edit</button>`
                : `<span class="pill" title="A policy that produced assessments is locked">locked</span>`
            }
          </div>
        </li>`
          )
          .join("")
      : `<li class="empty">No policies yet. Register the first one.</li>`;
  }

  renderOwnershipPanel();
  renderWalletNote();
  renderPolicySelect();
}

function renderOwnershipPanel() {
  const host = $('[data-view="policies"] .app-shell');
  if (!host) return;
  let panel = $("#ownership-panel");
  if (!panel) {
    host.insertAdjacentHTML(
      "beforeend",
      `<section class="panel" id="ownership-panel">
        <header class="panel-head"><h2>Contract ownership</h2><span class="pill" id="ownership-state">—</span></header>
        <dl class="kv" id="ownership-kv"></dl>
        <div class="field-row" style="margin-top:14px">
          <label class="field"><span class="field-label">Nominate a successor</span><input id="nominee" placeholder="0x…" /></label>
          <button class="btn btn-ghost" type="button" id="nominate-btn">Nominate</button>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" type="button" data-action="accept-ownership">Accept as nominee</button>
        </div>
        <p class="hint">Two-step on purpose: a mistyped address cannot freeze policy registration.</p>
      </section>`
    );
    panel = $("#ownership-panel");
    $("#nominate-btn")?.addEventListener("click", () => {
      const input = $("#nominee");
      try {
        store.transferOwnership(input.value);
        input.value = "";
        toast("ok", "Nominated", "The successor must accept before ownership moves.");
      } catch (error) {
        toast("error", "Not nominated", humanizeError(error));
      }
    });
  }

  const state = $("#ownership-state");
  const kv = $("#ownership-kv");
  const pending = store.state.pendingOwner;
  const hasPending = pending !== "0x" + "0".repeat(40);
  if (state) {
    state.textContent = hasPending ? "pending" : "settled";
    state.className = `pill ${hasPending ? "warn" : "ok"}`;
  }
  if (kv) {
    kv.innerHTML = `
      <div><dt>owner</dt><dd class="addr">${escapeHtml(store.state.owner)}</dd></div>
      <div><dt>nominated</dt><dd class="addr">${escapeHtml(hasPending ? pending : "none")}</dd></div>`;
  }
}

function startPolicyEdit(policyId) {
  const policy = store.state.policies[policyId];
  const form = $("#policy-form");
  if (!policy || !form) return;
  editingPolicyId = policyId;
  form.policy_id.value = policy.policy_id;
  form.policy_id.readOnly = true;
  form.name.value = policy.name;
  form.source_url.value = policy.source_url;
  form.guidance.value = policy.guidance;
  const title = $("#policy-form-title");
  if (title) title.textContent = `Edit ${policy.name}`;
  const cancel = $("#policy-cancel");
  if (cancel) cancel.hidden = false;
  const label = form.querySelector("[data-label]");
  if (label) label.textContent = "Save changes";
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetPolicyForm() {
  const form = $("#policy-form");
  if (!form) return;
  editingPolicyId = null;
  form.reset();
  form.policy_id.readOnly = false;
  const title = $("#policy-form-title");
  if (title) title.textContent = "Register a policy";
  const cancel = $("#policy-cancel");
  if (cancel) cancel.hidden = true;
  const label = form.querySelector("[data-label]");
  if (label) label.textContent = "Register policy";
  form.querySelectorAll("[aria-invalid]").forEach((node) => node.removeAttribute("aria-invalid"));
  const errorBox = form.querySelector("[data-form-error]");
  if (errorBox) errorBox.hidden = true;
}

async function submitPolicyForm(form) {
  const button = form.querySelector("[data-submit]");
  const payload = {
    policy_id: form.policy_id.value,
    name: form.name.value,
    source_url: form.source_url.value,
    guidance: form.guidance.value,
  };
  const errorBox = form.querySelector("[data-form-error]");
  if (errorBox) errorBox.hidden = true;

  await withBusy(button, async () => {
    await wait(220);
    try {
      if (editingPolicyId) {
        store.updatePolicy({ ...payload, policy_id: editingPolicyId });
        toast("ok", "Policy updated", "The rules URL is saved before any assessment uses it.");
      } else {
        store.registerPolicy(payload);
        toast("ok", "Policy registered", "It is now locked once its first assessment runs.");
      }
      resetPolicyForm();
    } catch (error) {
      const message = humanizeError(error);
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = message;
      }
      toast("error", "Policy not saved", message);
    }
  });
}

function togglePolicy(policyId, currentlyActive) {
  try {
    store.setPolicyActive(policyId, !currentlyActive);
    toast("ok", currentlyActive ? "Policy disabled" : "Policy enabled", `Assessments can${currentlyActive ? " no longer" : " now"} use ${policyId}.`);
  } catch (error) {
    toast("error", "Not changed", humanizeError(error));
  }
}

function renderPolicySelect() {
  const select = $('#assess-form select[name="policy_id"]');
  if (!select) return;
  const active = Object.values(store.state.policies).filter((policy) => policy.active);
  const previous = select.value;
  select.innerHTML = active.length
    ? active
        .map(
          (policy) =>
            `<option value="${escapeHtml(policy.policy_id)}">${escapeHtml(policy.name)} — ${escapeHtml(policy.policy_id)}</option>`
        )
        .join("")
    : `<option value="">No active policy</option>`;
  if (previous && active.some((policy) => policy.policy_id === previous)) select.value = previous;
}

/* ── assess ───────────────────────────────────────────────────────────── */

let lastRecord = null;

function renderAssess() {
  renderPolicySelect();
  const ref = $("#submit-ref");
  if (ref && !ref.value) ref.value = newSubmitRef();
  if (lastRecord) renderResult(lastRecord);
}

function renderProgress(container, step) {
  const steps = [
    "Fetching the rules page",
    "Committee is judging the transaction",
    "Validators re-derive the answer",
    "Writing the agreed verdict",
  ];
  container.innerHTML = `
    <div class="progress">
      ${steps
        .map((label, index) => {
          const state = index < step ? "done" : index === step ? "active" : "";
          return `<div class="progress-step ${state}"><span class="dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div>`;
        })
        .join("")}
    </div>`;
}

async function runAssessment(form) {
  const button = form.querySelector("[data-submit]");
  const resultBody = $("#result-body");
  const resultState = $("#result-state");
  const errorBox = form.querySelector("[data-form-error]");
  if (errorBox) errorBox.hidden = true;

  const payload = {
    policy_id: form.policy_id.value,
    subject: form.subject.value,
    counterparty: form.counterparty.value,
    amount: form.amount.value,
    context: form.context.value,
    submit_ref: form.submit_ref.value,
  };

  await withBusy(button, async () => {
    if (resultState) {
      resultState.textContent = "running";
      resultState.className = "pill warn";
    }
    /* Drop the previous verdict first: the store emits when the new one lands,
       and renderAssess would otherwise flash the old result over the progress. */
    lastRecord = null;
    renderProgress(resultBody, 0);
    await wait(320);
    renderProgress(resultBody, 1);
    await wait(420);
    renderProgress(resultBody, 2);
    await wait(380);
    renderProgress(resultBody, 3);

    let record = null;
    try {
      record = store.assess(payload);
      lastRecord = record;
    } catch (error) {
      const message = humanizeError(error);
      if (resultState) {
        resultState.textContent = "refused";
        resultState.className = "pill bad";
      }
      if (resultBody) {
        resultBody.innerHTML = `<div class="form-error" role="alert">${escapeHtml(message)}</div>`;
      }
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = message;
      }
      toast("error", "Assessment refused", message);
      return;
    }

    await wait(220);
    renderResult(record);
    if (resultState) {
      resultState.textContent = record.verdict.toLowerCase();
      resultState.className = `pill ${
        record.verdict === "COMPLIANT" ? "ok" : record.verdict === "NON_COMPLIANT" ? "bad" : "warn"
      }`;
    }
    form.submit_ref.value = newSubmitRef();
    toast("ok", "Verdict recorded", `${record.assessment_id} · ${record.verdict} · ${record.risk_band} risk.`);
  });
}

function renderResult(record) {
  const body = $("#result-body");
  if (!body || !record) return;

  const verdictClass =
    record.verdict === "COMPLIANT" ? "chip-compliant" : record.verdict === "NON_COMPLIANT" ? "chip-non-compliant" : "chip-review";
  const grounded = Boolean(record.rule_quote);
  const rotationText = record.consensus?.rotations ? `${record.consensus.rotations} rotation(s)` : "first leader";

  body.innerHTML = `
    <div class="verdict-hero">
      <div>
        <div class="title">${escapeHtml(record.subject || "—")} → ${escapeHtml(record.counterparty || "—")}</div>
        <div class="sub">${escapeHtml(record.policy_id)} · v${escapeHtml(record.policy_version)} · ${escapeHtml(record.assessment_id)}</div>
      </div>
      <span class="chip ${verdictClass}">${escapeHtml(record.verdict)}</span>
    </div>

    <div class="detail-grid">
      <div class="detail"><span>risk level</span><strong class="${record.risk_band === "HIGH" ? "red" : record.risk_band === "MEDIUM" ? "amber" : "mint"}">${escapeHtml(record.risk_band)}</strong></div>
      <div class="detail"><span>score</span><strong>${escapeHtml(record.risk_score)}</strong></div>
      <div class="detail"><span>amount</span><strong>${escapeHtml(record.amount || "—")}</strong></div>
      <div class="detail"><span>stored at</span><strong>${escapeHtml(new Date(record.created_at).toLocaleString())}</strong></div>
      <div class="detail"><span>submit ref</span><strong>${escapeHtml(record.submit_ref)}</strong></div>
      <div class="detail"><span>requester</span><strong>${escapeHtml(shortAddress(record.requester))}</strong></div>
    </div>

    ${
      grounded
        ? `<blockquote class="quote">“${escapeHtml(record.rule_quote)}”</blockquote>
           <p class="hint"><span class="dot-ok" aria-hidden="true"></span> Citation found verbatim in the fetched rules.</p>`
        : `<div class="form-error" role="status">The model could not quote the source, so the verdict was downgraded to REVIEW and the citation dropped. It cannot certify anything.</div>`
    }

    <div class="panel" style="padding:14px;background:rgba(255,255,255,.02)">
      <p class="small muted"><b>Findings.</b> ${escapeHtml(record.findings || "—")}</p>
      <p class="hint mono">rules_digest ${escapeHtml(shortAddress(record.rules_digest, 12, 10))}</p>
    </div>

    <div class="consensus">
      <header><span>what the committee agreed on</span><span>${escapeHtml(rotationText)}</span></header>
      <div class="row"><span>leader verdict</span><span class="agree">${escapeHtml(record.consensus?.verdict || record.verdict)}</span></div>
      <div class="row"><span>validator verdict</span><span class="agree">${escapeHtml(record.consensus?.verdict || record.verdict)}</span></div>
      <div class="row"><span>verdict compared</span><span class="${record.consensus?.agree ? "agree" : "disagree"}">${record.consensus?.agree ? "agree" : "undetermined"}</span></div>
      <div class="row"><span>risk level compared</span><span class="${record.consensus?.agree ? "agree" : "disagree"}">${escapeHtml(record.risk_band)} · ${record.consensus?.agree ? "agree" : "undetermined"}</span></div>
      <div class="row"><span>citation grounded</span><span class="${grounded ? "agree" : "disagree"}">${grounded ? "yes" : "no — downgraded to REVIEW"}</span></div>
    </div>
  `;
}

/* ── escrows ──────────────────────────────────────────────────────────── */

function openEscrowForm() {
  const panel = $("#escrow-form-panel");
  if (!panel) return;
  const select = $('#escrow-form select[name="assessment_id"]');
  const actor = store.actorAddress().toLowerCase();
  const eligible = Object.values(store.state.assessments).filter(
    (record) => record.verdict === "COMPLIANT" && record.requester.toLowerCase() === actor && !store.state.usedAssessments[record.assessment_id]
  );
  if (select) {
    select.innerHTML = eligible.length
      ? eligible
          .map(
            (record) =>
              `<option value="${escapeHtml(record.assessment_id)}">${escapeHtml(record.assessment_id)} — ${escapeHtml(record.subject)} (${escapeHtml(record.risk_band)})</option>`
          )
          .join("")
      : `<option value="">No eligible COMPLIANT assessment</option>`;
  }
  const amount = $('#escrow-form input[name="amount"]');
  const payee = $('#escrow-form input[name="payee"]');
  if (amount && !amount.value) amount.value = "1000";
  if (payee && !payee.value) payee.value = store.state.actor === "owner" ? STRANGER_ADDRESS : store.state.owner;
  panel.hidden = false;
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function closeEscrowForm() {
  const panel = $("#escrow-form-panel");
  if (panel) panel.hidden = true;
}

async function submitEscrowForm(form) {
  const button = form.querySelector("[data-submit]");
  const errorBox = form.querySelector("[data-form-error]");
  if (errorBox) errorBox.hidden = true;

  await withBusy(button, async () => {
    await wait(220);
    if (!form.assessment_id.value) {
      const message = "You need a COMPLIANT assessment you ran yourself. Run one on the Assess page first.";
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = message;
      }
      toast("error", "Nothing to fund", message);
      return;
    }
    try {
      const escrow = store.createEscrow({
        assessment_id: form.assessment_id.value,
        payee: form.payee.value,
        amount: form.amount.value,
        reference: form.reference.value,
      });
      if (escrow.status === "ORPHAN") {
        toast("error", "Deposit held as ORPHAN", `Refused: ${escrow.refusal}. The GEN is recorded against you and refundable.`);
      } else {
        toast("ok", "Escrow funded", `${formatWei(escrow.amount)} wei locked in ${escrow.escrow_id}.`);
      }
      form.reset();
      closeEscrowForm();
    } catch (error) {
      const message = humanizeError(error);
      if (errorBox) {
        errorBox.hidden = false;
        errorBox.textContent = message;
      }
      toast("error", "Deposit refused", message);
    }
  });
}

function settleEscrow(escrowId, kind) {
  const escrow = store.state.escrows[escrowId];
  if (!escrow) return;
  const verb = kind === "release" ? "release" : "refund";
  const target = kind === "release" ? "the payee" : "the funder";
  if (!window.confirm(`${verb} ${formatWei(escrow.amount)} wei to ${target}?`)) return;
  try {
    if (kind === "release") store.releaseEscrow(escrowId);
    else store.refundEscrow(escrowId);
    toast("ok", `Escrow ${verb}d`, `${escrowId} · ${formatWei(escrow.amount)} wei sent to ${target}.`);
  } catch (error) {
    toast("error", "Not settled", humanizeError(error));
  }
}

function renderEscrows() {
  const list = $("#escrow-list");
  if (!list) return;

  const escrows = Object.values(store.state.escrows).sort((a, b) => String(b.escrow_id).localeCompare(String(a.escrow_id)));
  const actor = store.actorAddress().toLowerCase();
  const ledger = store.state.ledger;
  const ok = store.ledgerOk();
  const pill = $("#escrow-ledger-state");
  if (pill) {
    pill.textContent = ok ? "balanced" : "mismatch";
    pill.className = `pill ${ok ? "ok" : "bad"}`;
  }

  if (!escrows.length) {
    list.innerHTML = `<li class="empty">No escrows yet. Fund one against a COMPLIANT assessment.</li>`;
    return;
  }

  list.innerHTML = escrows
    .map((escrow) => {
      const isFunder = escrow.funder.toLowerCase() === actor;
      const open = escrow.status === "FUNDED" || escrow.status === "ORPHAN";
      const expired = store.isEscrowExpired(escrow);
      const canAct = open && (isFunder || expired);
      return `
      <li class="escrow-card">
        <div class="escrow-top">
          <div>
            <div class="list-title">${escapeHtml(escrow.escrow_id)} · ${formatWei(escrow.amount)} wei</div>
            <div class="list-sub mono">${escapeHtml(shortAddress(escrow.funder))} → ${escapeHtml(shortAddress(escrow.payee))}${escrow.reference ? ` · ${escapeHtml(escrow.reference)}` : ""}</div>
          </div>
          ${statusPill(escrow.status)}
        </div>
        ${
          escrow.status === "ORPHAN"
            ? `<p class="escrow-warning">Refused deposit (${escapeHtml(escrow.refusal)}). It belongs to the sender and can be refunded.</p>`
            : ""
        }
        <div class="escrow-actions">
          ${
            canAct && escrow.status === "FUNDED"
              ? `<button class="btn btn-primary btn-sm" type="button" data-action="escrow-release" data-id="${escapeHtml(escrow.escrow_id)}">Release to payee</button>`
              : ""
          }
          ${
            canAct
              ? `<button class="btn btn-ghost btn-sm" type="button" data-action="escrow-refund" data-id="${escapeHtml(escrow.escrow_id)}">Refund to funder</button>`
              : ""
          }
          ${open && !canAct ? `<span class="hint">Only the funder can move this escrow.</span>` : ""}
          ${expired && open ? `<span class="hint">Timeout active: anyone may trigger the refund.</span>` : ""}
        </div>
      </li>`;
    })
    .join("");

  const summary = `locked ${formatWei(ledger.locked_total)} · out ${formatWei(ledger.total_out)}`;
  if (pill) pill.title = summary;
}

/* ── boot ─────────────────────────────────────────────────────────────── */

setupChrome();
render();
restoreWallet();
