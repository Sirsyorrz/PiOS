import type { ReactNode } from "react";
import type { Machine } from "../machine.ts";
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

      <EndpointPicker machine={machine} onChange={onMachineChange} onForget={onForget} />
    </ModalCard>
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
