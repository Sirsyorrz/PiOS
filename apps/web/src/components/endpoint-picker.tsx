import { useState } from "react";
import { probeEndpoint, type Machine } from "../machine.ts";

type Probe = Record<string, "unknown" | "checking" | "up" | "down">;

/**
 * Chooses which route to the machine to dial.
 *
 * Endpoints are listed by key, and a probe is the only thing that promotes
 * one: a remembered URL can point at a different machine on a different
 * network, so reachability is tested rather than assumed.
 */
export function EndpointPicker({ machine, onChange, onForget }: {
  machine: Machine;
  onChange: (machine: Machine) => void;
  onForget: () => void;
}) {
  const [probes, setProbes] = useState<Probe>({});
  const [draft, setDraft] = useState("");

  async function probe(key: string, url: string) {
    setProbes((p) => ({ ...p, [key]: "checking" }));
    const ok = await probeEndpoint(url);
    setProbes((p) => ({ ...p, [key]: ok ? "up" : "down" }));
    if (ok) onChange({ ...machine, preferredKey: key });
  }

  function add(event: React.FormEvent) {
    event.preventDefault();
    const url = draft.trim();
    if (!url) return;
    const key = `manual:${url}`;
    if (machine.endpoints.some((e) => e.key === key)) return;
    onChange({ ...machine, endpoints: [...machine.endpoints, { key, url }] });
    setDraft("");
  }

  return (
    <div className="endpoints">
      <h2>Endpoints</h2>
      <ul>
        {machine.endpoints.map((endpoint) => (
          <li key={endpoint.key} className={machine.preferredKey === endpoint.key ? "active" : ""}>
            <button type="button" onClick={() => onChange({ ...machine, preferredKey: endpoint.key })}>
              <span className="key">{endpoint.key}</span>
              <span className="muted">{endpoint.url}</span>
            </button>
            <span className={`probe ${probes[endpoint.key] ?? "unknown"}`}>
              {probes[endpoint.key] ?? "?"}
            </span>
            <button type="button" onClick={() => void probe(endpoint.key, endpoint.url)}>
              test
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={add}>
        <input
          value={draft}
          placeholder="http://host:4111"
          inputMode="url"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>

      <button type="button" className="danger" onClick={onForget}>
        Forget this machine
      </button>
    </div>
  );
}
