# Changelog

The commits below are grouped into the milestones that actually changed the
project. Individual fix commits are not listed; each milestone links to the
commit that introduces it.

## 1. The contract
- `3309dbf` — ClauseGuard (then ComplianceGate): policy registry, rule-sourced
  assessment, risk banding, citation grounding, consensus on `verdict` + `risk_level`.
- `d27bb94` — rename to ClauseGuard.

## 2. Custody and hardening

- `414cd1d` — funder-only escrow backed by a COMPLIANT verdict.
- `86be1b7` — deposits can never be stranded (ORPHAN instead of revert), payouts hardened.
- `3222a70` — 30-day unwind fallback that always pays the funder.
- `4d9ff2e` — drop the receive hook the linter rejects.
- `545c7ab` — unbound results closed, duplicate `submit_ref` refused per caller.

## 3. Consensus and error semantics

- `874af81` — two coarse consensus fields instead of an integer score.
- `024bc46` — an agreed rollback counts as a refusal, not a success.
- `d6151aa` — the citation invariant asserted honestly.
- `e782775` — verify non-idempotent writes instead of blind retries.
- `fce16ac` — poll for the payout instead of reading the balance too early.

## 4. Ownership, SSRF and provenance

- `d458203` — two-step ownership, source-host guard (no private hosts, no IP literals),
  rules digest stored per assessment.
- `2e8bc72` — digest the rules text the function actually receives.

## 5. The live network suite

- `9639b83` — studionet suite covering the contract and its adversarial paths.
- `ace6fc5`, `f0d9890`, `38714e3` — address printing, correct account wiring, long waits, real receipts.
- `6f10ae4` — one deployment per run with the plain client.
- `f82bcab`, `73f9f1d` — the suite runs when contract/test/wallet code changes, not on every push.

## 6. The console

- `cf1e19f` — first static console (readable verdict, custody ledger, assessment panel).
- `8897033` — rebuilt as a React + Vite app under `frontend/` with its own visual identity.
- `b09012d` — EIP-6963 wallet connection: MetaMask/Rabby listed separately, user picks one.

## 7. On-chain, one shared contract

- `1a951f6` — real genlayer-js wiring: reads, wallet-signed writes, decided receipts, consensus detail.
- `43296b9` — one pinned contract in `frontend/src/config.js`; no deploy button for visitors.
- `92a1045` — anyone may register a policy behind an anti-spam fee; owner collects it.
- `8c7e53a` — addresses serialised `0x…` everywhere (a live-suite finding), more tests.

## 8. Verification and delivery

- `b90aaf1` — every public method driven on the network with the tester wallets (25/25).
- `6df3488`, `1b4b1e0` — wallet smoke on the pinned contract, including the guard paths.
- `5e35858` — adversarial live cases: orphan deposits, ownership guards, inactive policy.
- `eb45350` — ESLint for the frontend plus a Frontend Lint CI job.
- `449f4a8` — Vercel configuration and deployment instructions.
