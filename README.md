# ClauseGuard

Automated compliance and risk assessment on GenLayer.

An Intelligent Contract that reads a policy's rules straight from the web, asks an
LLM to decide whether a transaction complies with those rules, scores its residual
risk, and stores an auditable verdict — with validators independently
re-deriving the decision before anything is written on-chain.

## Why GenLayer

Classic smart contracts cannot read a regulation page or judge whether a payment
"looks like" a sanctioned transfer. GenLayer contracts can, because web access and
LLM calls run inside non-deterministic blocks, and the Equivalence Principle makes
validators agree on the outcome before state changes.

## How a verdict is produced

1. **Policy registry** — the owner registers a policy: an id (lowercased, bounded
   charset), a rules URL, and analyst guidance. URLs must be `https://`. Once a
   policy has produced an assessment it is locked for edits, so every stored
   verdict stays reproducible against the rules that produced it.
2. **Rule fetch** — inside the non-deterministic block the contract renders the
   rules page as text (truncated to `MAX_RULES_CHARS`).
3. **LLM decision** — the model returns `verdict` (three classes), a
   `risk_level` (LOW / MEDIUM / HIGH), a `rule_quote`, and `findings`. A citation
   that is not found in the fetched rules cannot certify anything: the verdict is
   downgraded to `REVIEW` and the quote dropped, rather than failing the whole
   assessment — a hard failure leaves consensus with no decision to agree on.
4. **Validator** — re-runs the whole fetch-and-judge step independently and
   requires exact equality on `verdict` and `risk_level`. Those are the two
   coarse decision fields; an integer score is exactly the value two independent
   models disagree on, and when validators disagree the transaction becomes
   *undetermined* and writes nothing. The stored integer is derived from the
   agreed level (LOW 20, MEDIUM 50, HIGH 80), so it cannot drift either.
5. **Storage** — only after consensus: the assessment is written (with policy
   version, verified quote, and submit reference), the id counter advances, and
   the O(1) summary counters increment.

Storage reads never happen inside the non-deterministic block — every value the
leader needs is copied into memory first.

### Error consensus

Failures are classified so that validators agree for the right reasons:

- `[EXPECTED]` / `[EXTERNAL]` — deterministic (bad input, empty rules page). Must
  match exactly on tag and code.
- `[TRANSIENT]` — unreachable source. Both nodes transient means agreement.
- `[LLM_ERROR]` — malformed or ungrounded model output. Always disagree, forcing
  a retry with a different leader.

Errors are compared by tag and first code segment, not by full message text, so
two nodes reporting the same deterministic failure agree rather than deadlocking
on differing stack detail.

## Contract API

**Write**

| Method | Who | Purpose |
|---|---|---|
| `register_policy(policy_id, name, source_url, guidance)` (payable) | owner free; anyone else posts `POLICY_FEE_WEI` | Add a rules-backed policy |
| `update_policy(policy_id, name, source_url, guidance)` | owner or the policy's creator | Change a policy that has no assessments yet |
| `set_policy_active(policy_id, active)` | owner | Enable/disable a policy |
| `withdraw_policy_fees()` | owner | Collect the registration fees the contract holds |
| `transfer_ownership(new_owner)` | owner | Nominate a successor |
| `accept_ownership()` | the nominee | Take over; a typo cannot lose control |
| `assess(policy_id, subject, counterparty, amount, context, submit_ref)` | anyone | Run the assessment, returns assessment id (`ca-1`, `ca-2`, …) |
| `create_escrow(assessment_id, payee, reference)` (payable) | anyone with their own COMPLIANT assessment | Deposit GEN against that verdict |
| `release_escrow(escrow_id)` | the escrow's funder only | Pay the payee |
| `refund_escrow(escrow_id)` | the escrow's funder only | Return the deposit to the funder |

**View**

| Method | Returns |
|---|---|
| `get_owner()` | owner address |
| `get_pending_owner()` | nominated successor, zero when none |
| `get_policy(policy_id)` | policy record (name, source, guidance, active, count, version) |
| `get_policies()` | all policies keyed by id |
| `get_assessment(assessment_id)` | one assessment incl. verified `rule_quote`, `rules_digest` and `submit_ref` |
| `get_assessments()` | all assessments keyed by id |
| `get_assessment_ids()` | `{"ids": [...]}` in insertion order |
| `get_escrow(escrow_id)` | funder, payee, amount, status, bound assessment, created_ts |
| `is_escrow_expired(escrow_id)` | whether the 30-day unwind fallback is active |
| `get_ledger()` | total_deposited, total_out, locked_total |
| `get_balance()` | GEN actually held by the contract |
| `get_policy_fee()` | `fee_wei` for a non-owner registration, and `pending` fees the owner can withdraw |
| `get_summary()` | totals: total, compliant, non_compliant, review, high_risk, policies |

Risk levels: `LOW` (stored as 20), `MEDIUM` (50), `HIGH` (80). The level is the
value consensus agrees on; the number is a fixed representative of it, so two
runs can never store different numbers for the same decision.

## Escrow: money only its owner can move

An assessment on its own moves nothing. Value enters only through
`create_escrow`, which is payable and requires an assessment **you** ran whose
verdict is `COMPLIANT`:

- the deposit is recorded against `gl.message.sender_address` as `funder`;
- the assessment is marked used, so one verdict can never back two escrows;
- `create_escrow` is the only payable entry point, so value can only arrive
  attached to a recorded funder — there is no bare-transfer path into the
  contract and therefore no ownerless GEN;
- a payable call never reverts once value is attached: if the target is refused
  (wrong verdict, someone else's assessment, recycled verdict, invalid or zero
  payee), the deposit is stored as an `ORPHAN` escrow owned by the sender and
  can be pulled back with `refund_escrow`. Money must never be trapped by a
  failed call.

Both exits check the stored funder against the caller:

- `release_escrow` pays the payee — only the funder may call it;
- `refund_escrow` returns the deposit — the funder may always call it, and
  after `ESCROW_TIMEOUT_SECONDS` (30 days) anyone may trigger it, but the
  money still goes to the stored funder. That is a liveness fallback, never a
  way to take custody.

The payee has no path to pull funds, a stranger cannot release or refund, and a
`NON_COMPLIANT` or `REVIEW` verdict cannot be funded at all. Money leaves via
`emit_transfer` to an EOA, with the ledger updated first and the transfer last:
if the transfer fails the whole transaction reverts and the ledger rolls back
with it. Before any payout the contract checks both that the ledger still owes
the amount and that the real balance still covers it, so a transfer that left
while the state was rolled back cannot be paid twice. Solvency is tracked by the
storage ledger (`total_deposited`, `locked_total`, `total_out`) — `self.balance`
is only used as that second net.

## Security properties

- **Double submit** — every assessment carries a caller-scoped `submit_ref`, and
  the pair (requester, ref) is stored. A retry or duplicate submission reverts
  with `[EXPECTED]:duplicate_submit` instead of minting a second record. Refs are
  scoped per caller, so one account cannot burn another's.
- **Caller-supplied text is untrusted** — `subject`, `counterparty`, `amount` and
  `context` are whitespace-normalised, length-capped, and stripped of angle
  brackets so they cannot break out of the `<transaction>` block. The prompt
  frames them as facts that must never be read as instructions.
- **Grounded reasoning** — `rule_quote` is verified as a substring of the fetched
  rules text, so the stored justification cannot invent a rule. It is descriptive
  only; no later computation reads it.
- **Bounded growth** — at most `MAX_POLICIES` (100) policies and
  `MAX_ASSESSMENTS` (5000) assessments; ids, URLs, names and guidance are all
  length-capped.
- **Bounded reads** — `get_summary()` reads write-time counters rather than
  walking the whole assessment set.
- **Reproducibility** — a policy cannot be re-pointed at new rules once it has
  produced assessments; register a new policy id instead.
- **Funder-only custody** — no method transfers value except `release_escrow`
  and `refund_escrow`. Release requires the stored funder. Refund allows the
  funder always, and anyone after the 30-day timeout, but the payout target is
  always the stored funder, so no third party can redirect it.
  `create_escrow` rejects a payee that is the funder or the zero address.
- **No orphaned funds** — `create_escrow` is the only payable entry point, so
  value can only enter through a call that records a funder, and a refused
  deposit becomes a refundable `ORPHAN` instead of being stranded by a revert.
  The ledger invariant `total_deposited == total_out + locked_total` holds
  after every state change.
- **Citations survive formatting** — `rule_quote` is matched after folding both
  sides to letters and digits, so punctuation, casing or line wrapping cannot
  make a genuine citation fail or let a fake one pass.
- **Rules digest** — each assessment stores the keccak digest of the excerpt the
  leader actually read, so an auditor can tell which text produced the verdict
  even after the source page changes. It is descriptive: validators do not
  compare it, because a live page can differ slightly between two fetches.
- **No SSRF probe** — a source URL must be `https`, must have a real hostname,
  and may not be an IP literal, `localhost`, a `*.local` / `*.internal` host or
  a cloud metadata name. The node resolves the name itself, so without this the
  owner could point the committee at a private network.
- **Two-step ownership** — the owner nominates a successor and that address must
  accept, so a mistyped address cannot freeze policy registration.

Known limits: `findings` is stored as descriptive text that is never fed back
into a decision, and a source page that changes between the leader's fetch and a
validator's is only visible through the stored digest, not enforced.

## Integration on studionet

`tester1` signs the deploy and the owner-only calls; `tester2` plays both the
escrow payee and the stranger in the adversarial cases. The suite deploys the
contract **once** for the whole module and talks to it through the plain
`genlayer_py` client, the same shape the other GenLayer projects here use:
receipts judged by `status_name` *and* an `execution_result` of `SUCCESS` (an
agreed rollback is still an ACCEPTED transaction), a ten second poll, and a retry
around the calls that depend on live LLM consensus.

```bash
pytest tests/integration -v -s
```

The suite exercises every method in order: policy registry and its
authorisation guards, a real assessment (live fetch + live LLM + real
consensus), submit-ref replay, policy locking, prompt-tag neutralisation,
escrow deposit, a stranger trying to release and refund, a real payout, and
policy-id normalisation.

Two facts about it:

- the assessment verdict is whatever consensus produced, so the tests assert
  that consensus happened and that the stored record is well formed (the score
  is a fixed representative of the agreed level), never which verdict came out;
- the escrow unwind branches on the stored status — `FUNDED` releases to the
  payee, `ORPHAN` refunds to the funder — so one real transfer still happens
  either way.

`.github/workflows/integration.yml` runs the suite when the contract changes
or on demand (`workflow_dispatch`): it deploys to studionet, pays for real
execution, and depends on live web and LLM behaviour.

## Addresses

The contract address changes on every run, so the only address worth funding is
the pinned test account:

| Role | Address |
|---|---|
| Fundable test account (tester1 — signer and escrow funder) | `0xE8b3e800d08727D25156a44cD1609F793bd0Af5a` |
| Second test account (tester2 — escrow payee and the stranger) | `0x0C0Fd005478Cef9219451BBD19Dfc6C0586fC1Ad` |

Each run deploys a new contract, so a contract address from an earlier run is
dead. The two accounts above stay the same because their keystores live in the
repository (`tests/tester1-keystore.json`, `tests/tester2-keystore.json`).

### Funding the escrow for real

1. send GEN to the tester1 address above — a fraction of one GEN is plenty, the
   escrow tests deposit 1000 wei;
2. run the suite (or start the workflow): `pytest tests/integration -v -s`;
3. `scripts/wallet.py` unlocks `tests/tester1-keystore.json`, so the deploy and
   every owner call are signed by tester1 and `accounts[1]` is tester2 — the
   same addresses on every run;
4. `create_escrow` then moves real value out of tester1, and the run finishes
   with `release_escrow` (pays tester2) or `refund_escrow` (back to tester1).
   The suite asserts the contract's real balance moved by exactly the deposit
   and back down by exactly the payout, alongside `get_ledger()`.

**Rotate these keys.** The keystore passwords (`tests/tester1.password`,
`tests/tester2.password`) are committed, which makes the keys effectively public
to anyone who can read this repository, history included. They are acceptable as
throwaway studionet accounts holding dust; do not reuse them anywhere else. To
stop relying on the committed passwords, set `CLAUSEGUARD_TESTER1_PASSWORD` and
`CLAUSEGUARD_TESTER2_PASSWORD` as repository secrets — `scripts/wallet.py`
prefers them — and then delete the `.password` files.

Studionet's faucet is the droplet in the Studio account selector and funds the
Studio account, not an arbitrary address. If tester1 is not a Studio account you
control, send GEN from a wallet, or use Bradbury
(`--network testnet_bradbury`) whose faucet accepts any address.

## Seeing transactions in the explorer

Direct mode never touches a chain, so nothing it runs can appear anywhere. The
same suite against studionet is different: `client.deploy_contract()` and every
`write_contract()` are real transactions on that network.

The suite prints the deployed address once and the id of every transaction, so
run it with `-s` and the output looks like:

```
[clauseguard] deployed at 0x...
[clauseguard] register_policy -> 0x...
[clauseguard] assess -> 0x...
[clauseguard] create_escrow -> 0x...
```

Paste either the contract address or a transaction id into the Studio explorer
([explorer-studio.genlayer.com](https://explorer-studio.genlayer.com)) to see
the deployment and each call against the contract.

Two caveats:

- studionet state is temporary — that trail can disappear when the environment
  is reset. For a persistent trail, run the same suite against Bradbury
  (`--network testnet_bradbury`), which needs your own funded keys.
- a write that reverts still exists on the network: the assertion says it
  failed, the explorer shows where.

The same trail can be produced without tests: deploy from the Studio UI and use
its Execute Transactions panel, or use the CLI (`genlayer deploy`,
`genlayer write`).

## Frontend

`frontend/` is a **React 18 + Vite** console for the contract. No UI kit: one
hand-written design system in `frontend/src/styles.css`, a hash router in
`App.jsx`, and a page per view. It is the only frontend in the repository.

- **Landing** — what the contract does, the four steps, and the properties that
  keep the failure modes boring.
- **Dashboard** — verdict counters, the custody ledger with its invariant, and the
  most recent assessments.
- **Policies** — register, edit (while unlocked), enable/disable, and the two-step
  ownership handover.
- **Assess** — the full flow, including the citation that was grounded and a
  side-by-side of what leader and validators compared.
- **Escrows** — fund against one of your own `COMPLIANT` verdicts, then release or
  refund, with the timeout rule spelled out.
- **How it works** — the consensus payload, the citation invariant, the error
  taxonomy and the money rules.

The look is deliberately not a stock dark dashboard: an ink-violet ground under
warm ivory serif headings, acid-lime / coral / iris accents, brass hairlines and
corner ticks, and a background built from slowly rotating contour lines, a soft
scan sweep and film grain — all CSS and inline SVG, no images to download.

**Wallet connection** is real and wallet-agnostic. `frontend/src/wallet.js`
discovers injected EVM wallets with **EIP-6963**, so MetaMask and Rabby each
announce their own provider and appear as separate rows in the chooser modal —
neither one overwrites `window.ethereum`, and the one you pick is the one that
signs. After the choice the page asks for an account, then adds or switches to
**GenLayer Studio Network** (`chainId 61999` / `0xf22f`, RPC
`https://studio.genlayer.com/api`) and follows `accountsChanged` and
`chainChanged` afterwards.

The connected address becomes the acting account for every guard in the console:
the owner/stranger toggle is hidden while a wallet is connected, a connected
wallet that is not the contract owner gets an explicit note on the Policies page
instead of a silent refusal, and escrows and submit references are scoped to the
real account. Connection is plain EIP-1193, so the console needs no wallet
library. Wallets are only visible when the page runs in a browser that has an
injected provider — MetaMask's or Rabby's in-app browser, or a desktop browser
with the extension; a plain mobile browser has none, and the chooser says so.

**It runs on-chain against one shared contract.** `frontend/src/config.js` holds
that contract's address; `scripts/deploy.py` (run by the **Deploy Contract**
workflow) deploys it once, writes the address into the config and seeds a starter
policy, and every visitor then reads and writes that same contract. There is
deliberately no deploy button: using the console can never create another
contract.

`frontend/src/chain.js` talks to GenLayer Studio through **genlayer-js**: reads gothrough a wallet-less client (`readContract`), writes are signed by the connected
EVM wallet (`writeContract`), and every write waits for the committee
(`waitForTransactionReceipt({ waitUntil: "decided" })`) before it is treated as
done. A write only counts when consensus accepted it *and* execution returned
(`FINISHED_WITH_RETURN`); otherwise the leader receipt's error tag is surfaced
with the same friendly copy the simulator uses. Reads refresh on load and after
every write, and the Assess result adds the on-chain receipt — status, execution
result, leader vote, validator count and rounds — next to the agreement the
contract stored. The header badge says `on-chain` or `simulation`.

**Anyone may add a policy.** On chain a non-owner pays a small, one-off
registration fee (`POLICY_FEE_WEI`, held by the contract and withdrawable by the
owner); the owner registers for free. The fee is what keeps the registry from
filling with throwaway rule pages, and a policy still locks the moment it produces
an assessment, so a verdict can never be rewritten underneath it.

While no address is recorded yet, the console falls back to
`frontend/src/contract.js`, a deterministic stand-in with the same guards, error
codes, `ORPHAN`-instead-of-revert deposit rule, ledger invariant and
caller-scoped `submit_ref` replay refusal. Both backends sit behind one API, so
the pages are identical in either mode.

## Layout

```
contracts/ClauseGuard.py      the Intelligent Contract
tests/direct/                 in-memory tests (no Docker, milliseconds each)
tests/integration/            real-network tests (genlayer_py client)
frontend/                     React + Vite console
frontend/src/App.jsx          header, wallet chooser, hash router
frontend/src/pages/           landing, dashboard, policies, assess, escrows, how
frontend/src/contract.js      store: chain backend + deterministic stand-in
frontend/src/chain.js         genlayer-js reads, writes, receipts
frontend/src/config.js        the one deployed contract address
scripts/deploy.py             the only deployer; records the address
.github/workflows/deploy-contract.yml  deploys once and commits the address
frontend/src/wallet.js        EIP-6963 discovery and connection
frontend/src/styles.css       design system
Dockerfile                    builds frontend/ and serves dist with nginx
gltest.config.yaml            network config, used by direct-mode runs
.github/workflows/ci.yml      lint, direct-mode tests, frontend build
.github/workflows/integration.yml  real-network suite, on push or by hand
requirements.txt              pinned SDK, test suite, linter
```

## Running it locally

```bash
pip install -r requirements.txt

# 1. lint — catches forbidden imports, invalid storage types, nondet misuse
genvm-lint check contracts/ClauseGuard.py

# 2. direct-mode tests — in-memory, mocked web + LLM
pytest tests/direct/ -v

# 3. integration tests — one deploy, real network, live LLM consensus
pytest tests/integration -v -s

# 4. the console
cd frontend && npm install && npm run dev     # http://localhost:5173
cd frontend && npm run build                  # static files in frontend/dist

# 5. deploy the shared contract once (writes its address into the config);
#    in CI this is the "Deploy Contract" workflow, never the app itself
python scripts/deploy.py
```

## Developing without a terminal

This repository is set up so the whole loop works through GitHub Actions:

- `Lint Contracts` runs `genvm-lint check`.
- `Direct Mode Tests` runs `pytest tests/direct/`.

Push to `main` (or open a pull request) and read the job logs. Direct mode covers
contract logic, storage, access control, and consensus comparison
(`tests/direct/test_consensus.py` replays the validator against a stored leader
result); a failure there is a real failure, not a guess. The integration workflow
runs itself on any push that touches `contracts/`, `tests/integration/` or
`scripts/`, and by hand from the Actions tab; only true multi-validator behaviour
needs the real network.

## Extending it

- **Real rule sources** — point a policy at a public sanctions list, a regulator's
  fee schedule, or an internal policy page. The contract only needs text.
- **Rule snapshots** — store a digest of the fetched rules text alongside the
  verdict so an auditor can prove which exact version was applied.
- **Review queue** — read `get_summary()` and `get_assessments()` through
  `genlayer-js` to build a queue of `REVIEW` verdicts for human analysts.
