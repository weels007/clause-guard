/** GenLayer on-chain transport.
 *
 * Everything the console needs from genlayer-js lives here: reads through a
 * wallet-less client, writes signed by the connected EVM wallet, receipt
 * waiting, and the consensus data the receipt carries.
 */
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

export const CHAIN = studionet;
export const EXPLORER = "https://explorer-studio.genlayer.com";

export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (address) => `${EXPLORER}/address/${address}`;

/** BigInt and SDK wrapper types are not safe to render; flatten them once. */
function plain(value) {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) {
    const out = {};
    for (const [key, item] of value.entries()) out[key] = plain(item);
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = plain(item);
    return out;
  }
  return value;
}

/** Read a view with a client that needs no wallet, so the console is read-only
 *  usable before anyone connects. */
export async function readView(address, functionName, args = []) {
  const client = createClient({ chain: studionet });
  const value = await client.readContract({ address, functionName, args });
  return plain(value);
}

function walletClient(address, provider) {
  return createClient({ chain: studionet, account: address, provider });
}

const WAIT = { waitUntil: "decided", interval: 3000, retries: 140 };

/** Send a write, wait for the committee, and return the receipt. */
export async function sendWrite({ address, account, provider, functionName, args = [], value = 0, onHash }) {
  const client = walletClient(account, provider);
  /* No-op when the wallet is already on Studio; a switch prompt otherwise. */
  await client.connect("studionet");
  const hash = await client.writeContract({
    address,
    functionName,
    args,
    value: BigInt(value || 0),
  });
  if (onHash) onHash(hash);
  const receipt = await client.waitForTransactionReceipt({ hash, ...WAIT });
  return { hash, receipt };
}

/** A write is only real if consensus accepted it AND execution succeeded. */
export function succeeded(receipt) {
  const status = String(receipt?.statusName || receipt?.status || "").toUpperCase();
  if (status && status !== "ACCEPTED" && status !== "FINALIZED") return false;

  const execution = String(receipt?.txExecutionResultName || "");
  if (execution) return execution === "FINISHED_WITH_RETURN";

  const leader = receipt?.consensus_data?.leader_receipt?.[0];
  const leaderResult = String(leader?.execution_result || leader?.result || "").toUpperCase();
  if (leaderResult) return leaderResult === "SUCCESS" || leaderResult === "FINISHED_WITH_RETURN";

  const numeric = receipt?.txExecutionResult;
  if (typeof numeric === "number") return numeric === 1;
  return true;
}

/** Pull a contract error out of the leader receipt, keeping the error tag. */
export function receiptError(receipt) {
  const leader = receipt?.consensus_data?.leader_receipt?.[0];
  const raw = String(leader?.error || receipt?.consensus_data?.error || receipt?.error || "").trim();
  const match = raw.match(/\[(EXPECTED|EXTERNAL|TRANSIENT|LLM_ERROR)\](?::([A-Za-z0-9_]+))?/);
  if (match) {
    return { code: `[${match[1]}]${match[2] ? `:${match[2]}` : ""}`, message: raw };
  }
  const status = String(receipt?.statusName || receipt?.status || "").toUpperCase();
  if (status === "UNDETERMINED") {
    return { code: "[TRANSIENT]:undetermined", message: "Validators did not reach consensus; nothing was written." };
  }
  return { code: "", message: raw || "The contract rejected the transaction." };
}

/** The consensus detail a receipt carries, shaped for the result panel. */
export function consensusOf(receipt) {
  if (!receipt) return null;
  const data = receipt.consensus_data || {};
  const leaderList = Array.isArray(data.leader_receipt) ? data.leader_receipt : [];
  const leader = leaderList[0] || null;
  const validators = Array.isArray(data.validators) ? data.validators : [];
  const votes = data.votes && typeof data.votes === "object" ? Object.values(data.votes) : [];
  const lastRound = receipt.lastRound || {};
  return {
    status: receipt.statusName || String(receipt.status ?? ""),
    result: receipt.resultName || "",
    execution: receipt.txExecutionResultName || (leader && leader.execution_result) || "",
    leaderVote: leader?.vote || leader?.result || "",
    validators: validators.length,
    rotVotes: votes.length,
    rounds: receipt.numOfRounds ? Number(receipt.numOfRounds) : null,
    rotationsLeft: lastRound.rotationsLeft != null ? Number(lastRound.rotationsLeft) : null,
    roundValidators: Array.isArray(lastRound.roundValidators) ? lastRound.roundValidators.length : 0,
    final: Boolean(data.final),
  };
}
