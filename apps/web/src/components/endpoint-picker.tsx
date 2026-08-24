import { useState } from "react";
import { probeEndpoint, type Endpoint, type Machine } from "../machine.ts";

type ProbeState = "unknown" | "checking" | "up" | "down";

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
  const [checking, setChecking] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function patchEndpoint(key: string, patch: Partial<Endpoint>): Endpoint[] {
    return machine.endpoints.map((e) => (e.key === key ? { ...e, ...patch } : e));
  }

  async function probe(endpoint: Endpoint) {
    setChecking(endpoint.key);
    const ok = await probeEndpoint(endpoint.url);
    setChecking(null);
    onChange({
      ...machine,
      endpoints: patchEndpoint(endpoint.key, { lastProbe: { ok, at: Date.now() } }),
      preferredKey: ok ? endpoint.key : machine.preferredKey,
    });
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
        {machine.endpoints.map((endpoint) => {
          const state = probeState(endpoint, checking === endpoint.key);
          return (
            <li key={endpoint.key} className={machine.preferredKey === endpoint.key ? "active" : ""}>
              <button
                type="button"
                className="endpoint"
                onClick={() => onChange({ ...machine, preferredKey: endpoint.key })}
              >
                <span className="key">{endpoint.key}</span>
                <span className="muted">{endpoint.url}</span>
              </button>
              <div className="row spread">
                <span className={`probe ${state}`}>{probeLabel(state, endpoint)}</span>
                <button type="button" onClick={() => void probe(endpoint)}>
                  Test
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <form className="row" onSubmit={add}>
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

function probeState(endpoint: Endpoint, checking: boolean): ProbeState {
  if (checking) return "checking";
  if (!endpoint.lastProbe) return "unknown";
  return endpoint.lastProbe.ok ? "up" : "down";
}

function probeLabel(state: ProbeState, endpoint: Endpoint): string {
  if (state === "checking") return "testing...";
  if (state === "unknown") return "untested";
  const when = new Date(endpoint.lastProbe?.at ?? 0).toLocaleTimeString();
  // The time is part of the answer: reachable an hour ago on another network
  // is not reachable.
  return `${state === "up" ? "reachable" : "unreachable"} at ${when}`;
}
