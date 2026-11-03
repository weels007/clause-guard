/** Small presentation helpers: escaping, formatting, toasts, busy buttons. */

const ERROR_COPY = {
  "unauthorized": "Only the contract owner can do that.",
  "policy_exists": "That policy id is already registered.",
  "policy_limit": "The contract has reached its policy limit.",
  "empty_policy_id": "A policy id is required.",
  "invalid_policy_id": "Use lowercase letters, digits and - _ . only.",
  "policy_id_too_long": "That policy id is too long.",
  "empty_name": "A name is required.",
  "empty_guidance": "Analyst guidance is required.",
  "invalid_source_url": "The rules URL must be https on a public hostname.",
  "source_url_too_long": "That URL is too long.",
  "unknown_policy": "That policy does not exist.",
  "policy_inactive": "That policy is disabled.",
  "policy_locked": "This policy already produced assessments, so it is locked. Register a new one.",
  "missing_subject": "A subject is required.",
  "missing_submit_ref": "A submit reference is required.",
  "duplicate_submit": "That reference was already used by this caller. Regenerate it.",
  "assessment_limit": "The contract has reached its assessment limit.",
  "zero_deposit": "A deposit must be positive.",
  "unknown_escrow": "That escrow does not exist.",
  "escrow_closed": "That escrow is already settled.",
  "not_funder": "Only the funder can move this escrow.",
  "zero_owner": "The zero address cannot own the contract.",
  "no_pending_owner": "Nobody has been nominated to take over.",
  "not_pending_owner": "Only the nominated address can accept.",
  "invalid_address": "That is not a valid address.",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[character];
  });
}

export function shortAddress(value, head = 6, tail = 4) {
  const text = String(value ?? "");
  if (text.length <= head + tail + 2) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export function formatWei(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

export function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function humanizeError(error) {
  if (!error) return "Something went wrong.";
  const code = String(error.code || "");
  const bare = code.replace(/^\[[A-Z_]+\]:/, "");
  if (ERROR_COPY[bare]) return ERROR_COPY[bare];
  return error.message || "Something went wrong.";
}

export function toast(kind, title, message) {
  const stack = document.getElementById("toasts");
  if (!stack) return;

  const node = document.createElement("div");
  node.className = `toast ${kind === "error" ? "err" : "ok"}`;
  node.setAttribute("role", kind === "error" ? "alert" : "status");
  node.innerHTML = `
    <span class="bar" aria-hidden="true"></span>
    <div class="body">
      <b>${escapeHtml(title)}</b>
      <div>${escapeHtml(message || "")}</div>
    </div>`;
  stack.appendChild(node);

  window.setTimeout(() => {
    node.classList.add("leaving");
    window.setTimeout(() => node.remove(), 220);
  }, 5200);
}

/** Disable a button for the duration of an async action so it cannot fire twice. */
export async function withBusy(button, task) {
  if (!button) return task();
  if (button.dataset.busy === "1") return null;

  const label = button.querySelector("[data-label]");
  const originalLabel = label ? label.textContent : null;
  button.dataset.busy = "1";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (label) label.textContent = "Working…";
  if (!button.querySelector(".spin")) {
    button.insertAdjacentHTML("afterbegin", '<span class="spin" aria-hidden="true"></span>');
  }

  try {
    return await task();
  } finally {
    button.dataset.busy = "";
    button.disabled = false;
    button.removeAttribute("aria-busy");
    const spin = button.querySelector(".spin");
    if (spin) spin.remove();
    const current = button.querySelector("[data-label]");
    /* Undo only our own placeholder: a finished task may relabel the button on
       purpose (the policy form flips back to "Register policy" after a save). */
    if (current && current.textContent === "Working…" && originalLabel !== null) {
      current.textContent = originalLabel;
    }
  }
}

export function showFormError(form, message) {
  const box = form?.querySelector("[data-form-error]");
  if (!box) return;
  if (!message) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.hidden = false;
  box.textContent = message;
}

export function verdictChip(verdict) {
  const map = {
    COMPLIANT: "chip-compliant",
    NON_COMPLIANT: "chip-non-compliant",
    REVIEW: "chip-review",
  };
  return `<span class="chip ${map[verdict] || "chip-review"}">${escapeHtml(verdict || "—")}</span>`;
}

export function statusPill(status) {
  const map = {
    FUNDED: "warn",
    ORPHAN: "bad",
    RELEASED: "ok",
    REFUNDED: "ok",
  };
  return `<span class="pill ${map[status] || ""}">${escapeHtml(status || "—")}</span>`;
}

let revealObserver = null;

function revealWatcher() {
  if (revealObserver) return revealObserver;
  revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.12 }
  );
  return revealObserver;
}

/** Fade/slide elements into view once, respecting reduced-motion. */
export function armReveals(root = document) {
  const elements = root.querySelectorAll("[data-reveal]:not(.is-visible)");
  if (!elements.length) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    elements.forEach((element) => element.classList.add("is-visible"));
    return;
  }

  const observer = revealWatcher();
  elements.forEach((element) => observer.observe(element));
}

export function newSubmitRef(prefix = "assess") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
