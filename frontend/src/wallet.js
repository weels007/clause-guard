/** EVM wallet discovery and connection.
 *
 * Discovery uses EIP-6963: every injected wallet announces itself, so MetaMask
 * and Rabby each become their own list entry instead of overwriting
 * window.ethereum. The user picks one from a modal; nothing assumes a winner.
 *
 * Connection is plain EIP-1193 JSON-RPC, so the page needs no dependency. The
 * chain descriptor mirrors studionet from genlayer-js (id 61999, 0xf22f).
 */

export const GENLAYER_CHAIN = {
  chainId: "0xf22f",
  chainName: "GenLayer Studio Network",
  rpcUrls: ["https://studio.genlayer.com/api"],
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  blockExplorerUrls: [{ name: "GenLayer Explorer", url: "https://explorer-studio.genlayer.com" }],
};

export const GENLAYER_CHAIN_ID = 61999;

const KNOWN_NAMES = {
  "io.metamask": "MetaMask",
  "io.rabby": "Rabby",
  "com.coinbase.wallet": "Coinbase Wallet",
};

function nameFor(provider, rdns, fallback) {
  if (rdns && KNOWN_NAMES[rdns]) return KNOWN_NAMES[rdns];
  if (fallback) return fallback;
  if (provider?.isRabby) return "Rabby";
  if (provider?.isMetaMask) return "MetaMask";
  if (provider?.isCoinbaseWallet) return "Coinbase Wallet";
  return "Injected wallet";
}

function legacyProviders() {
  const injected = window.ethereum;
  if (!injected) return [];

  if (Array.isArray(injected.providers) && injected.providers.length) {
    return injected.providers.map((provider, index) => {
      const rdns = provider?.isMetaMask ? "io.metamask" : provider?.isRabby ? "io.rabby" : "";
      return {
        uuid: `legacy-${index}`,
        name: nameFor(provider, rdns, `Injected wallet ${index + 1}`),
        rdns,
        icon: "",
        provider,
      };
    });
  }

  const rdns = injected.isRabby ? "io.rabby" : injected.isMetaMask ? "io.metamask" : "";
  return [
    {
      uuid: "legacy-0",
      name: nameFor(injected, rdns, "Injected wallet"),
      rdns,
      icon: "",
      provider: injected,
    },
  ];
}

/** Collect every injected wallet the browser offers.
 *
 * EIP-6963 wallets answer `eip6963:requestProvider` with their own details
 * (name, icon, rdns, provider). Wallets too old for that are still reachable
 * through window.ethereum / window.ethereum.providers, so they are added when
 * no announcement arrived at all.
 */
export function discoverWallets(timeoutMs = 400) {
  return new Promise((resolve) => {
    const found = new Map();

    const onAnnounce = (event) => {
      const detail = event.detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      if (found.has(detail.info.uuid)) return;
      found.set(detail.info.uuid, {
        uuid: detail.info.uuid,
        name: detail.info.name || nameFor(detail.provider, detail.info.rdns, "Wallet"),
        rdns: detail.info.rdns || "",
        icon: detail.info.icon || "",
        provider: detail.provider,
      });
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);

    try {
      window.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch {
      /* older browsers still get the legacy fallback below */
    }

    window.setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      const found_ = Array.from(found.values());
      resolve(found_.length ? found_ : legacyProviders());
    }, timeoutMs);
  });
}

export function walletErrorMessage(error) {
  const code = Number(error?.code);
  const message = String(error?.message || "");
  if (code === 4001 || /reject|denied|deny/i.test(message)) {
    return "You rejected the request in your wallet.";
  }
  if (code === -32002 || /already pending/i.test(message)) {
    return "That wallet already has a pending request. Open the wallet and finish it first.";
  }
  if (code === 4902 || /unrecognized chain/i.test(message)) {
    return "That network is not in the wallet yet.";
  }
  return message || "The wallet request failed.";
}

/** Ask the chosen wallet for an account and put it on the GenLayer chain. */
export async function connectProvider(provider) {
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const address = Array.isArray(accounts) ? accounts[0] : "";
  if (!address) throw new Error("The wallet returned no account.");

  let chainId = String(await provider.request({ method: "eth_chainId" }));
  let switched = false;

  if (chainId.toLowerCase() !== GENLAYER_CHAIN.chainId) {
    switched = true;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: GENLAYER_CHAIN.chainId }],
      });
    } catch (error) {
      if (Number(error?.code) !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [GENLAYER_CHAIN],
      });
    }
    chainId = String(await provider.request({ method: "eth_chainId" }));
  }

  return {
    address,
    chainId,
    switched,
    onChain: chainId.toLowerCase() === GENLAYER_CHAIN.chainId,
  };
}

/** Reconnect silently to a wallet the page already knows, without a popup. */
export async function findWallet(rdns, name) {
  const wallets = await discoverWallets(300);
  return (
    wallets.find((wallet) => rdns && wallet.rdns === rdns) ||
    wallets.find((wallet) => name && wallet.name === name) ||
    wallets[0] ||
    null
  );
}
