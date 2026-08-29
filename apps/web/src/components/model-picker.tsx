import type { ModelListing } from "@pios/client-core";
import type { ModelOption } from "@pios/protocol";
import { useEffect, useState } from "react";
import { useClient } from "../client-provider.tsx";

/**
 * Switches the model for one session, from the input dock.
 *
 * Only the session's model scope is offered: that is the short list a phone
 * can choose from, and it fits a native select. The full catalogue stays
 * behind `/model`, where a search field makes it usable.
 */
export function ModelPicker({ sessionId, current }: {
  sessionId: string;
  current?: ModelOption;
}) {
  const client = useClient();
  const [listing, setListing] = useState<ModelListing>(() => client.getModels(sessionId));

  useEffect(
    () =>
      client.onModels((changed, next) => {
        if (changed === sessionId) setListing(next);
      }),
    [client, sessionId],
  );

  // The answer depends on which providers are authenticated right now, so it
  // is asked again whenever the session changes rather than cached forever.
  useEffect(() => {
    setListing(client.getModels(sessionId));
    client.listModels(sessionId, { all: false });
  }, [client, sessionId]);

  // `/model` replaces the cached listing with the whole catalogue; the dock
  // stays short by keeping only the scope out of it. A session without a
  // configured scope has nothing marked, so there the catalogue is the list.
  const scoped = listing.models.filter((m) => m.scoped);
  const models = scoped.length > 0 ? scoped : [...listing.models];
  // The active model can sit outside the scope, e.g. picked through `/model`.
  // Without this the select would silently show something that is not running.
  if (current && !models.some((m) => m.provider === current.provider && m.modelId === current.modelId)) {
    models.unshift(current);
  }

  const value = current ? key(current) : "";

  function choose(next: string) {
    const model = models.find((m) => key(m) === next);
    if (model) client.setModel(sessionId, model.provider, model.modelId);
  }

  return (
    <select
      className="ghost model-select"
      aria-label="model"
      value={value}
      onChange={(event) => choose(event.target.value)}
    >
      {current ? null : <option value="">Model</option>}
      {models.map((model) => (
        <option key={key(model)} value={key(model)}>
          {model.name}
        </option>
      ))}
    </select>
  );
}

function key(model: ModelOption): string {
  return `${model.provider}/${model.modelId}`;
}
