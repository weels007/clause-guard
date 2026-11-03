import { useEffect, useMemo, useState } from "react";

/* ── toasts ───────────────────────────────────────────────────── */

let toastItems = [];
let toastSeq = 0;
const toastListeners = new Set();

function emitToasts() {
  toastListeners.forEach((listener) => listener());
}

export function toast(kind, title, message) {
  const id = ++toastSeq;
  toastItems = [...toastItems, { id, kind, title, message }];
  emitToasts();
  window.setTimeout(() => {
    toastItems = toastItems.filter((item) => item.id !== id);
    emitToasts();
  }, 5200);
}

export function Toasts() {
  const [items, setItems] = useState(toastItems);

  useEffect(() => {
    const update = () => setItems(toastItems);
    toastListeners.add(update);
    update();
    return () => toastListeners.delete(update);
  }, []);

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind === "error" ? "err" : "ok"}`} role={item.kind === "error" ? "alert" : "status"}>
          <span className="bar" aria-hidden="true" />
          <div className="body">
            <b>{item.title}</b>
            <div>{item.message}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── atmosphere ───────────────────────────────────────────────── */

const RING_COUNT = 26;

export function Background() {
  const rings = useMemo(
    () =>
      Array.from({ length: RING_COUNT }, (_, i) => ({
        rx: 46 + i * 27,
        ry: 30 + i * 17.5,
        rotate: i * 0.9,
        opacity: 0.06 + ((i * 7) % 5) * 0.018,
      })),
    []
  );

  return (
    <div className="bg" aria-hidden="true">
      <div className="bg-base" />
      <svg className="bg-contours" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice">
        {rings.map((ring, index) => (
          <ellipse
            key={index}
            cx="400"
            cy="300"
            rx={ring.rx}
            ry={ring.ry}
            opacity={ring.opacity}
            transform={`rotate(${ring.rotate} 400 300)`}
          />
        ))}
      </svg>
      <div className="bg-scan" />
      <svg className="bg-grain">
        <filter id="cg-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#cg-grain)" opacity="0.7" />
      </svg>
      <div className="bg-vignette" />
    </div>
  );
}

/** Rotating compliance seal used behind the hero docket. */
export function Seal() {
  return (
    <svg className="seal" viewBox="0 0 116 116" aria-hidden="true">
      <g className="seal-rings">
        <circle cx="58" cy="58" r="52" fill="none" stroke="rgba(230,201,139,0.34)" strokeWidth="1" strokeDasharray="2 6" />
        <circle cx="58" cy="58" r="41" fill="none" stroke="rgba(217,255,67,0.3)" strokeWidth="1" />
      </g>
      <g className="seal-arc">
        <path d="M58 8a50 50 0 0 1 35 15" fill="none" stroke="#d9ff43" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M58 108a50 50 0 0 1-35-15" fill="none" stroke="#957bff" strokeWidth="1.6" strokeLinecap="round" />
      </g>
      <text x="58" y="55" textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="8.5" letterSpacing="2" fill="#e6c98b">
        GEN
      </text>
      <text x="58" y="67" textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="8.5" letterSpacing="2" fill="#e6c98b">
        LAYER
      </text>
    </svg>
  );
}

/* ── small pieces ─────────────────────────────────────────────── */

const VERDICT_CLASS = {
  COMPLIANT: "chip-compliant",
  NON_COMPLIANT: "chip-non-compliant",
  REVIEW: "chip-review",
};

export function Chip({ verdict }) {
  return <span className={`chip ${VERDICT_CLASS[verdict] || "chip-review"}`}>{verdict || "—"}</span>;
}

const PILL_CLASS = { FUNDED: "warn", ORPHAN: "bad", RELEASED: "ok", REFUNDED: "ok" };

export function Pill({ status }) {
  return <span className={`pill ${PILL_CLASS[status] || ""}`}>{status || "—"}</span>;
}

export function Reveal({ children, delay = 0, className = "" }) {
  return (
    <div className={className} style={{ animation: "pageIn 0.6s cubic-bezier(0.2,0.7,0.2,1) both", animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}
