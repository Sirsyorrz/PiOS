import { useEffect, useState, type ReactNode } from "react";
import { httpBase, type Machine } from "../machine.ts";
import { disablePush, enablePush, pushState, type PushState } from "../push.ts";
import type { Settings } from "../settings.ts";
import type { UsageReport } from "@pios/protocol";
import { fetchUsage, formatSpend, resetsIn } from "../usage.ts";
import { ModalCard, PickerHeader } from "./ui.tsx";

/**
 * Every preference in one place, plus the machine itself.
 *
 * Preferences are defaults only: they decide how a session opens, and are
 * never pushed onto a transcript the reader has already adjusted by hand.
 */
export function SettingsView({ settings, machine, onChange, onForget, onClose }: {
  settings: Settings;
  machine: Machine;
  onChange: (settings: Settings) => void;
  onForget: () => void;
  onClose: () => void;
}) {
  const patch = (next: Partial<Settings>) => onChange({ ...settings, ...next });

  return (
    <ModalCard className="picker settings">
      <PickerHeader title="Settings" onCancel={onClose} />

      <div className="settings-group">
        <h3>Transcript</h3>
        <Toggle
          label="Show thinking by default"
          hint="Reasoning blocks open as they arrive."
          checked={settings.showThinking}
          onChange={(showThinking) => patch({ showThinking })}
        />
        <Toggle
          label="Expand tools by default"
          hint="Finished tool calls open their output."
          checked={settings.expandTools}
          onChange={(expandTools) => patch({ expandTools })}
        />
        <Toggle
          label="Show session stats"
          hint="Tokens, cost and context use under the last message."
          checked={settings.showSessionStats}
          onChange={(showSessionStats) => patch({ showSessionStats })}
        />
      </div>

      <div className="settings-group">
        <h3>Composer</h3>
        <Choice
          label="Mid-turn prompts"
          value={settings.steeringMode}
          options={[
            ["steer", "Steer"],
            ["followUp", "Follow-up"],
          ]}
          onChange={(steeringMode) => patch({ steeringMode })}
        />
      </div>

      <div className="settings-group">
        <h3>Directories</h3>
        <Choice
          label="Sort order"
          value={settings.directorySort}
          options={[
            ["recent", "Recent sessions first"],
            ["alphabetical", "Alphabetical"],
          ]}
          onChange={(directorySort) => patch({ directorySort })}
        />
      </div>

      <div className="settings-group">
        <h3>Claude usage</h3>
        <Usage machine={machine} />
      </div>

      <div className="settings-group">
        <h3>Notifications</h3>
        <Notifications machine={machine} />
      </div>

      <div className="settings-group">
        <h3>Machine</h3>
        <MachineRow machine={machine} onForget={onForget} />
      </div>
    </ModalCard>
  );
}

/**
 * Forgetting drops the device token, and getting it back means pairing again
 * at the machine, so it asks twice.
 */
function MachineRow({ machine, onForget }: { machine: Machine; onForget: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="settings-row">
      <span className="settings-label">
        <span>{machine.label}</span>
        <span className="muted">{machine.url}</span>
      </span>
      {confirming ? (
        <span className="row">
          <button type="button" className="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onForget}>
            Forget
          </button>
        </span>
      ) : (
        <button type="button" className="ghost" onClick={() => setConfirming(true)}>
          Forget
        </button>
      )}
    </div>
  );
}

/**
 * Push on `agent_settled`.
 *
 * Permission can only be asked for from a gesture, and on iOS only from an
 * installed web app, so every state the browser can be in is spelled out here
 * rather than hidden behind a toggle that silently does nothing.
 */
function Notifications({ machine }: { machine: Machine }) {
  const [state, setState] = useState<PushState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = httpBase(machine);

  useEffect(() => {
    let live = true;
    void pushState().then((next) => live && setState(next));
    return () => {
      live = false;
    };
  }, []);

  if (state === null) return <p className="muted">Checking...</p>;
  if (state === "needs-install") {
    return <p className="muted">Add PiOS to the home screen to enable notifications.</p>;
  }
  if (state === "unsupported") return <p className="muted">This browser has no Web Push.</p>;
  if (state === "denied") {
    return <p className="muted">Notifications are blocked in the browser settings.</p>;
  }

  const toggle = (wanted: boolean) => {
    if (!base) return setError("This machine has no valid address.");
    setBusy(true);
    setError(null);
    void (wanted
      ? enablePush(base, machine.deviceToken)
      : disablePush(base, machine.deviceToken)
    )
      .then(setState)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "failed"))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Toggle
        label="Notify when an agent settles"
        hint="One notification per turn, skipped while you are watching."
        checked={state === "on"}
        onChange={busy ? () => {} : toggle}
      />
      {error ? <p className="muted">{error}</p> : null}
    </>
  );
}

/**
 * Plan limits for the account the machine runs pi under.
 *
 * Read-only and best-effort: the daemon shells out to a CLI that may not be
 * installed, so "unavailable" is a normal answer and never an error.
 */
function Usage({ machine }: { machine: Machine }) {
  const [report, setReport] = useState<UsageReport | null | "loading" | "error">("loading");
  const base = httpBase(machine);

  useEffect(() => {
    if (!base) return;
    let live = true;
    void fetchUsage(base, machine.deviceToken)
      .then((next) => live && setReport(next))
      .catch(() => live && setReport("error"));
    return () => {
      live = false;
    };
  }, [base, machine.deviceToken]);

  if (report === "loading") return <p className="muted">Checking...</p>;
  if (report === "error") return <p className="muted">Could not reach the machine.</p>;
  if (!report) return <p className="muted">No usage data on this machine.</p>;

  return (
    <>
      {report.windows.map((window) => {
        const reset = window.resetsAt ? resetsIn(window.resetsAt) : null;
        return (
          <div key={window.key} className="usage-row">
            <span className="settings-label">
              <span>{window.label}</span>
              <span className="muted">
                {window.percent}% used{reset ? ` \u00b7 ${reset}` : ""}
              </span>
            </span>
            <span className="usage-bar">
              <span className="usage-fill" style={{ width: `${window.percent}%` }} />
            </span>
          </div>
        );
      })}
      {report.spend ? <p className="muted">Extra usage: {formatSpend(report.spend)}</p> : null}
    </>
  );
}

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
  return (
    <label className="settings-row">
      <span className="settings-label">
        <span>{label}</span>
        {hint ? <span className="muted">{hint}</span> : null}
      </span>
      {control}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      }
    />
  );
}

function Choice<T extends string>({ label, hint, value, options, onChange }: {
  label: string;
  hint?: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      control={
        <select value={value} onChange={(event) => onChange(event.target.value as T)}>
          {options.map(([option, text]) => (
            <option key={option} value={option}>
              {text}
            </option>
          ))}
        </select>
      }
    />
  );
}
