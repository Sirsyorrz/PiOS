import { useEffect, useState } from "react";
import { pairWithMachine, probeEndpoint, type Machine } from "../machine.ts";
import { messageOf } from "../format.ts";
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

/** Splits a pasted `pios-server pair` link into its origin and token. */
export function parsePairingLink(input: string): { origin: string; token: string } | null {
  let link: URL;
  try {
    link = new URL(input.trim());
  } catch {
    return null;
  }
  const token = new URLSearchParams(link.hash.replace(/^#/, "")).get("pt");
  return token ? { origin: link.origin, token } : null;
}

/**
 * Where the daemon probably is.
 *
 * The page origin comes first: in the packaged setup the relay serves this
 * app and carries every route, so the page's own origin is the machine. A
 * dev server on another port falls back to the daemon's own port on the same
 * host.
 */
function candidateDaemonUrls(): string[] {
  const { origin, protocol, hostname } = window.location;
  const samePort = `${protocol}//${hostname}:${DEFAULT_PORT}`;
  return origin === samePort ? [origin] : [origin, samePort];
}

export function PairingScreen({ notice, onPaired }: {
  /** Why the app is back here, when it did not start here. */
  notice?: string | null;
  onPaired: (machine: Machine) => void;
}) {
  const [token, setToken] = useState("");
  const [url, setUrl] = useState(() => candidateDaemonUrls()[0]!);
  // A guess that was typed over is the user's, and must not be overwritten by
  // a probe that finishes later.
  const [edited, setEdited] = useState(false);
  const [label, setLabel] = useState("phone");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const fromHash = takePairingTokenFromHash();
    if (fromHash) setToken(fromHash);
  }, []);

  // Only a successful probe proves an address; the first candidate is shown
  // meanwhile so the field is never empty.
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const candidate of candidateDaemonUrls()) {
        if (await probeEndpoint(candidate)) {
          if (live && !edited) setUrl(candidate);
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [edited]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Store only a parseable address: a bad one is unrecoverable from the UI.
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        throw new Error("machine URL is not valid, e.g. https://pios-relay.you.workers.dev");
      }
      const result = await pairWithMachine(parsed.origin, token.trim(), label.trim() || "phone");
      onPaired({
        id: result.deviceId,
        label: parsed.hostname,
        deviceToken: result.deviceToken,
        url: parsed.origin,
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalCard onSubmit={submit}>
      <h1>Pair with a machine</h1>
        {notice ? <p className="banner warn">{notice}</p> : null}
        <p className="muted">
          Run <code>pios-server pair</code> on the machine and open the printed link, or paste the
          whole link (or just the token) below.
        </p>

        <label>
          Machine URL
          <input
            value={url}
            onChange={(e) => {
              setEdited(true);
              setUrl(e.target.value);
            }}
            inputMode="url"
          />
        </label>
        <label>
          Pairing link or token
          <input
            value={token}
            onChange={(e) => {
              const link = parsePairingLink(e.target.value);
              if (!link) return setToken(e.target.value);
              setToken(link.token);
              setEdited(true);
              setUrl(link.origin);
            }}
            autoComplete="off"
          />
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
