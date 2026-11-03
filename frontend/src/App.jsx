import { useCallback, useEffect, useRef, useState } from "react";
import { createContract, useContract } from "./contract.js";
import {
  connectProvider,
  discoverWallets,
  findWallet,
  GENLAYER_CHAIN,
  GENLAYER_CHAIN_ID,
  walletErrorMessage,
} from "./wallet.js";
import { shortAddress } from "./format.js";
import { Background, Toasts, toast } from "./ui.jsx";
import Landing from "./pages/Landing.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Policies from "./pages/Policies.jsx";
import Assess from "./pages/Assess.jsx";
import Escrows from "./pages/Escrows.jsx";
import How from "./pages/How.jsx";

const contract = createContract();

const NAV = [
  { hash: "#/", key: "landing", label: "Home" },
  { hash: "#/dashboard", key: "dashboard", label: "Dashboard" },
  { hash: "#/policies", key: "policies", label: "Policies" },
  { hash: "#/assess", key: "assess", label: "Assess" },
  { hash: "#/escrows", key: "escrows", label: "Escrows" },
  { hash: "#/how", key: "how", label: "How it works" },
];

function currentRoute() {
  const path = (window.location.hash || "#/").slice(1) || "/";
  return NAV.find((item) => item.hash.slice(1) === path)?.key ?? "landing";
}

function useRoute() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => {
      setRoute(currentRoute());
      const root = document.documentElement;
      const previous = root.style.scrollBehavior;
      /* Jump, don't glide: the layout is swapped before the scroll lands. */
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, 0);
      root.style.scrollBehavior = previous;
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

export default function App() {
  const state = useContract(contract);
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [wallets, setWallets] = useState(null);
  const [walletError, setWalletError] = useState("");
  const [connecting, setConnecting] = useState(null);

  const providerRef = useRef(null);
  const handlersRef = useRef(null);
  const listeners = useRef(null);

  const detach = useCallback(() => {
    const provider = providerRef.current;
    const handlers = handlersRef.current;
    if (provider && handlers) {
      provider.removeListener?.("accountsChanged", handlers.onAccounts);
      provider.removeListener?.("chainChanged", handlers.onChain);
    }
    providerRef.current = null;
    handlersRef.current = null;
  }, []);

  const attach = useCallback(
    (provider, wallet) => {
      detach();

      const onAccounts = (accounts) => {
        if (!Array.isArray(accounts) || !accounts.length) {
          contract.clearWallet();
          detach();
          return;
        }
        const next = accounts[0];
        const current = contract.getState().wallet?.address;
        if (current && current.toLowerCase() === String(next).toLowerCase()) return;
        const walletState = contract.getState().wallet || {};
        contract.setWallet({
          address: next,
          name: wallet?.name || walletState.name,
          rdns: wallet?.rdns || walletState.rdns,
        });
        toast("ok", "Account switched", shortAddress(next));
      };

      const onChain = (chainId) => {
        if (String(chainId).toLowerCase() === GENLAYER_CHAIN.chainId) {
          toast("ok", "Network ready", `GenLayer Studio Network (${GENLAYER_CHAIN_ID}).`);
        } else {
          toast("error", "Wrong network", `Switch your wallet to GenLayer Studio Network (${GENLAYER_CHAIN_ID}).`);
        }
      };

      provider.on?.("accountsChanged", onAccounts);
      provider.on?.("chainChanged", onChain);
      providerRef.current = provider;
      listeners.current = { onAccounts, onChain };
    },
    [detach]
  );

  useEffect(() => () => detach(), [detach]);

  /* Silent reconnect: the provider is gone after a reload, the choice is not. */
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      const saved = contract.getState().wallet;
      if (!saved || !saved.address) return;
      let match = null;
      try {
        match = await findWallet(saved.rdns, saved.name);
      } catch {
        match = null;
      }
      if (!match || cancelled) return;
      try {
        const accounts = await match.provider.request({ method: "eth_accounts" });
        const stillThere =
          Array.isArray(accounts) && accounts.some((account) => String(account).toLowerCase() === saved.address.toLowerCase());
        if (!stillThere) {
          contract.clearWallet();
          return;
        }
        attach(match.provider, match);
        contract.setWallet({ address: saved.address, name: saved.name || match.name, rdns: saved.rdns || match.rdns });
      } catch {
        contract.clearWallet();
      }
    };

    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const openWallet = () => {
    setWalletOpen(true);
    setWalletError("");
    setWallets(null);
    discoverWallets().then((found) => setWallets(found));
  };

  useEffect(() => {
    if (!walletOpen) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") setWalletOpen(false);
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [walletOpen]);

  const connectWallet = async (wallet) => {
    if (!wallet || connecting) return;
    setWalletError("");
    setConnecting(wallet.uuid);
    try {
      const result = await connectProvider(wallet.provider);
      attach(wallet.provider, wallet);
      contract.setWallet({ address: result.address, name: wallet.name, rdns: wallet.rdns });
      setWalletOpen(false);
      if (!result.onChain) {
        toast(
          "error",
          "Wrong network",
          `Your wallet is on chain ${result.chainId}. Switch it to GenLayer Studio Network (${GENLAYER_CHAIN_ID}) to transact.`
        );
        return;
      }
      toast("ok", `Connected: ${wallet.name}`, `${shortAddress(result.address)} · GenLayer Studio Network (${GENLAYER_CHAIN_ID}).`);
    } catch (error) {
      setWalletError(walletErrorMessage(error));
    } finally {
      setConnecting(null);
    }
  };

  const disconnectWallet = () => {
    detach();
    contract.clearWallet();
    setWalletOpen(false);
    toast("ok", "Wallet disconnected", "Back to the demo accounts.");
  };

  const wallet = state.wallet || {};
  const connected = Boolean(wallet.address);
  const walletLabel = connected ? `${wallet.name || "Wallet"} · ${shortAddress(wallet.address)}` : "Connect wallet";

  return (
    <>
      <Background />
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="site-header">
        <div className="shell nav-shell">
          <a className="brand" href="#/" aria-label="ClauseGuard home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
                <path d="M9 12.2l2.2 2.2L15.4 10" />
              </svg>
            </span>
            <span className="brand-name">ClauseGuard</span>
            <span className="brand-badge">simulation</span>
          </a>

          <nav className="nav-links" aria-label="Primary">
            {NAV.map((item) => (
              <a key={item.key} href={item.hash} aria-current={route === item.key ? "page" : undefined}>
                {item.label}
              </a>
            ))}
          </nav>

          <div className="nav-actions">
            <button
              className="wallet-btn"
              type="button"
              data-connected={connected ? "true" : "false"}
              onClick={openWallet}
              title={connected ? wallet.address : "Connect an EVM wallet"}
            >
              <span className="wallet-dot" aria-hidden="true" />
              <span className="wallet-label">{walletLabel}</span>
            </button>

            {!connected && (
              <button
                className="actor-switch"
                type="button"
                data-actor={state.actor}
                onClick={() => contract.setActor(state.actor === "owner" ? "stranger" : "owner")}
                title="Switch the demo account acting on the contract"
              >
                <span className="actor-dot" aria-hidden="true" />
                <span>{state.actor === "owner" ? "owner" : "stranger"}</span>
              </button>
            )}

            <button
              className="menu-btn"
              type="button"
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>

        {menuOpen && (
          <div className="mobile-menu">
            {NAV.map((item) => (
              <a key={item.key} href={item.hash} onClick={() => setMenuOpen(false)} aria-current={route === item.key ? "page" : undefined}>
                {item.label}
              </a>
            ))}
            {!connected && (
              <button
                className="mobile-actor"
                type="button"
                onClick={() => {
                  contract.setActor(state.actor === "owner" ? "stranger" : "owner");
                  setMenuOpen(false);
                }}
              >
                acting as {state.actor} · switch account
              </button>
            )}
          </div>
        )}
      </header>

      <main id="main" tabIndex={-1}>
        {route === "landing" && <Landing contract={contract} state={state} />}
        {route === "dashboard" && <Dashboard contract={contract} state={state} />}
        {route === "policies" && <Policies contract={contract} state={state} />}
        {route === "assess" && <Assess contract={contract} state={state} />}
        {route === "escrows" && <Escrows contract={contract} state={state} />}
        {route === "how" && <How />}
      </main>

      <footer className="site-footer">
        <div className="shell footer-shell">
          <div>
            <span className="footer-mark">ClauseGuard</span>
            <p className="dim small" style={{ marginTop: 4 }}>
              Automated compliance and risk assessment on GenLayer.
            </p>
          </div>
          <nav className="footer-links" aria-label="Footer">
            <a href="#/how">How it works</a>
            <a href="#/policies">Policies</a>
            <a href="#/assess">Assess</a>
          </nav>
        </div>
      </footer>

      {walletOpen && (
        <div
          className="modal"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setWalletOpen(false);
          }}
        >
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
            <div className="modal-head">
              <div>
                <p className="eyebrow" style={{ marginBottom: 4 }}>
                  wallet
                </p>
                <h2 id="wallet-title">Connect a wallet</h2>
              </div>
              <button className="icon-btn" type="button" aria-label="Close" onClick={() => setWalletOpen(false)}>
                ✕
              </button>
            </div>

            <p className="hint" style={{ marginTop: 0 }}>
              MetaMask, Rabby and every other EIP-6963 wallet are listed as their own entry, each with its own provider. The one
              you pick is the one that signs.
            </p>

            {wallets === null && <div className="wallet-loading">Looking for installed wallets…</div>}

            {wallets && wallets.length > 0 && (
              <ul className="wallet-list">
                {wallets.map((entry) => (
                  <li key={entry.uuid}>
                    <button className="wallet-item" type="button" disabled={Boolean(connecting)} onClick={() => connectWallet(entry)}>
                      {entry.icon ? (
                        <img className="wallet-icon" src={entry.icon} alt="" width="28" height="28" />
                      ) : (
                        <span className="wallet-icon wallet-icon-empty" aria-hidden="true" />
                      )}
                      <span className="wallet-meta">
                        <span className="wallet-name">{entry.name}</span>
                        {entry.rdns && <span className="wallet-rdns">{entry.rdns}</span>}
                      </span>
                      <span className="wallet-go" aria-hidden="true">
                        {connecting === entry.uuid ? <span className="spin" /> : "→"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {wallets && wallets.length === 0 && (
              <div className="wallet-empty">
                <p>
                  <b>No EVM wallet found in this browser.</b>
                </p>
                <p className="hint" style={{ marginTop: 0 }}>
                  Install{" "}
                  <a className="link" href="https://metamask.io/download/" target="_blank" rel="noreferrer noopener">
                    MetaMask
                  </a>{" "}
                  or{" "}
                  <a className="link" href="https://rabby.io/" target="_blank" rel="noreferrer noopener">
                    Rabby
                  </a>
                  , then open this page inside that wallet's own browser.
                </p>
              </div>
            )}

            {walletError && (
              <div className="form-error" role="alert" style={{ marginTop: 14 }}>
                {walletError}
              </div>
            )}

            {connected && (
              <div className="wallet-foot">
                <button className="btn btn-ghost btn-sm" type="button" onClick={disconnectWallet}>
                  Disconnect current wallet
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <Toasts />
    </>
  );
}
