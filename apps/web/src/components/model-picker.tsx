import type { ModelListing } from "@pios/client-core";
import type { ModelOption } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";
import { browserStorage } from "../storage.ts";
import { ChevronDownIcon } from "./icons.tsx";

const SHOW_ALL_KEY = "pios.models.showAll";

/**
 * Switches the model for one session, from the input dock.
 *
 * Only the session's model scope is fetched by default: that is the short list
 * a phone can choose from. The full catalogue is a second request, made only
 * when asked for, and the choice is remembered.
 */
export function ModelPicker({ sessionId, current }: {
  sessionId: string;
  current?: ModelOption;
}) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(() => browserStorage.get(SHOW_ALL_KEY) === "1");
  const [listing, setListing] = useState<ModelListing>(() => client.getModels(sessionId));

  useEffect(
    () =>
      client.onModels((changed, next) => {
        if (changed === sessionId) setListing(next);
      }),
    [client, sessionId],
  );

  // Asked on open and on every scope change, not on mount: the answer depends
  // on which providers are authenticated right now, and most sessions never
  // open this.
  useEffect(() => {
    if (!open) return;
    setListing(client.getModels(sessionId));
    client.listModels(sessionId, { all: showAll });
  }, [client, sessionId, open, showAll]);

  function choose(model: ModelOption) {
    client.setModel(sessionId, model.provider, model.modelId);
    setOpen(false);
  }

  function toggleAll(value: boolean) {
    setShowAll(value);
    browserStorage.set(SHOW_ALL_KEY, value ? "1" : "0");
  }

  return (
    <div className="model-picker">
      {open ? (
        <div className="model-menu">
          <header>
            {/* The daemon can only answer with everything when it has no scope
                to narrow to, and then the toggle would be a lie. */}
            <span className="line">{listing.all ? "All models" : "Scoped models"}</span>
            <label className="all">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => toggleAll(event.target.checked)}
              />
              All
            </label>
          </header>
          <div className="model-list scroll-y">
            {listing.models.length === 0 ? <p className="muted">No models available.</p> : null}
            {listing.models.map((model) => {
              const active =
                model.provider === current?.provider && model.modelId === current?.modelId;
              return (
                <button
                  key={`${model.provider}/${model.modelId}`}
                  type="button"
                  className={`list-row ${active ? "active" : ""}`}
                  onClick={() => choose(model)}
                >
                  <span className="line">{model.name}</span>
                  <span className="muted line">{model.provider}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <button
        type="button"
        className="ghost model-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="line">{current?.name ?? "Model"}</span>
        <ChevronDownIcon className={`caret ${open ? "flip" : ""}`} />
      </button>
    </div>
  );
}
