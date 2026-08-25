import { useEffect, useState } from "react";
import { pairWithMachine, type Machine } from "../machine.ts";
import { ModalCard } from "./ui.tsx";

const DEFAULT_PORT = 4111;

/** Reads `#pt=<token>` and removes it from history in the same breath. */
function takePairingTokenFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const token = new URLSearchParams(hash).get("pt");
  if (!token) return null;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return token;
}

function guessDaemonUrl(): string {
  const { protocol, hostname, port } = window.location;
  // The PWA is usually served by the dev server on another port, so the page
  // origin is a hint about the host, never about the daemon's port.
  const daemonPort = port === String(DEFAULT_PORT) ? port : String(DEFAULT_PORT);
  return `${protocol}//${hostname}:${daemonPort}`;
}

export function PairingScreen({ onPaired }: { onPaired: (machine: Machine) => void }) {
  const [token, setToken] = useState("");
  const [url, setUrl] = useState(guessDaemonUrl);
  const [label, setLabel] = useState("phone");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fromHash = takePairingTokenFromHash();
    if (fromHash) setToken(fromHash);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await pairWithMachine(url, token.trim(), label.trim() || "phone");
      onPaired({
        id: result.deviceId,
        label: new URL(url).hostname,
        deviceToken: result.deviceToken,
        endpoints: [{ key: `paired:${new URL(url).host}`, url }],
        preferredKey: null,
      });
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalCard onSubmit={submit}>
      <h1>Pair with a machine</h1>
        <p className="muted">
          Run <code>pios-server pair</code> on the machine and open the printed link, or paste the
          token below.
        </p>

        <label>
          Daemon URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
        </label>
        <label>
          Pairing token
          <input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Device label
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>

        {error ? <p className="error">{error}</p> : null}
      <button type="submit" disabled={busy || !token.trim()}>
        {busy ? "Pairing..." : "Pair"}
      </button>
    </ModalCard>
  );
}
