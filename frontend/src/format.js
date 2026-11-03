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

export function newSubmitRef(prefix = "assess") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
