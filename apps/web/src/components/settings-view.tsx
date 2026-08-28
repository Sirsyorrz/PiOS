import { useEffect, useState, type ReactNode } from "react";
import { httpBase, type Machine } from "../machine.ts";
import { disablePush, enablePush, pushState, type PushState } from "../push.ts";
import type { Settings } from "../settings.ts";
import { EndpointPicker } from "./endpoint-picker.tsx";
import { ModalCard, PickerHeader } from "./ui.tsx";

/**
 * Every preference in one place, plus the machine's routes.
 *
 * Preferences are defaults only: they decide how a session opens, and are
 * never pushed onto a transcript the reader has already adjusted by hand.
 */
export function SettingsView({ settings, machine, onChange, onMachineChange, onForget, onClose }: {
  settings: Settings;
  machine: Machine;
  onChange: (settings: Settings) => void;
  onMachineChange: (machine: Machine) => void;
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
        <h3>Notifications</h3>
        <Notifications machine={machine} />
      </div>

      <EndpointPicker machine={machine} onChange={onMachineChange} onForget={onForget} />
    </ModalCard>
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
    if (!base) return setError("No endpoint selected.");
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
