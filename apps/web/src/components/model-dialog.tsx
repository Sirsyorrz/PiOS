import type { ModelListing, SessionCreate } from "@pios/client-core";
import type { ModelOption } from "@pios/protocol";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useClient } from "../client-provider.tsx";
import { ListRowButton, ModalCard, PickerHeader, SearchField } from "./ui.tsx";

/**
 * The full model catalogue, as `/model` offers it.
 *
 * The dock's select is the short list; this is everything the authenticated
 * providers expose, which is hundreds of rows. A native select cannot be
 * searched, so the command opens this instead.
 */
export function ModelDialog({ sessionId, create, current, onClose }: {
  sessionId: string;
  /** Set for a draft: the catalogue lives behind an agent, so asking starts one. */
  create?: SessionCreate;
  current?: ModelOption;
  onClose: () => void;
}) {
  const client = useClient();
  const [listing, setListing] = useState<ModelListing>(() => client.getModels(sessionId));
  const [filter, setFilter] = useState("");
  const [asked, setAsked] = useState(true);

  // The command was typed, so the keyboard is up and covers most of the list.
  // Nothing here is typed until the user taps the filter field.
  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
  }, []);

  useEffect(() => {
    const off = client.onModels((changed, next) => {
      if (changed === sessionId) setListing(next);
    });
    setListing(client.getModels(sessionId));
    setAsked(client.listModels(sessionId, { all: true, create }));
    return off;
  }, [client, sessionId, create]);

  // The cached listing can be the scoped one the dock asked for, so the wait
  // is for an answer that covers everything, not merely for any answer.
  const loading = !listing.all;
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? listing.models.filter((m) =>
        `${m.name} ${m.provider} ${m.modelId}`.toLowerCase().includes(needle),
      )
    : listing.models;

  function chooseModel(model: ModelOption) {
    client.setModel(sessionId, model.provider, model.modelId);
    onClose();
  }

  // Portalled to the body: the composer's `backdrop-filter` makes it the
  // containing block for fixed children, so a card left in place would be
  // clipped to the input dock instead of covering the screen.
  return createPortal(
    <ModalCard className="picker models" overlay>
      <PickerHeader title="Switch model" onCancel={onClose} />

      <SearchField value={filter} placeholder="Filter by name or provider" onChange={setFilter} />

      {!asked ? <p className="banner error">Not connected: the list may be stale.</p> : null}

      {loading && listing.models.length === 0 ? (
        <p className="muted loading">Reading models…</p>
      ) : shown.length === 0 ? (
        <p className="muted">No matching model.</p>
      ) : (
        <ul className="models-list scroll-y">
          {shown.map((model) => {
            const active =
              current?.provider === model.provider && current?.modelId === model.modelId;
            return (
              <li key={`${model.provider}/${model.modelId}`}>
                <ListRowButton
                  className={active ? "model active" : "model"}
                  onClick={() => chooseModel(model)}
                  trailing={active ? <span className="status running">active</span> : undefined}
                >
                  <span className="name line">{model.name}</span>
                  <span className="muted line">{model.provider}/{model.modelId}</span>
                </ListRowButton>
              </li>
            );
          })}
        </ul>
      )}
    </ModalCard>,
    document.body,
  );
}
