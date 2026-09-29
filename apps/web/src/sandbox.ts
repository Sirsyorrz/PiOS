import { saveMachines, type MachineStore } from "./machine.ts";

/** Defined by vite; false everywhere except a sandbox dev server. */
declare const __PIOS_SANDBOX__: boolean;

/**
 * Sandbox-only bootstrap: `?sandbox=1&token=...` pairs the app in one step.
 *
 * The normal pairing flow is a token in the fragment plus a confirmed
 * address, which is right for a phone meeting a machine it has never seen and wrong
 * for a throwaway backend that was created two seconds ago on this origin.
 *
 * Stripped from every other build: a URL that grants a device token without a
 * pairing exchange must not exist in a shipped app.
 */
export function adoptSandboxMachine(): MachineStore | null {
  if (typeof __PIOS_SANDBOX__ === "undefined" || !__PIOS_SANDBOX__) return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("sandbox") !== "1") return null;
  const token = params.get("token");
  if (!token) return null;

  // Same origin as the page: the dev server proxies the API to the daemon, so
  // there is one origin, no CORS, and nothing to pick.
  const url = window.location.origin;
  const store: MachineStore = {
    machines: [
      {
        id: "sandbox",
        label: params.get("label") ?? "sandbox",
        deviceToken: token,
        url,
      },
    ],
    activeId: "sandbox",
  };
  saveMachines(store);

  // Keep the token out of history and out of any link that gets copied.
  const clean = new URL(window.location.href);
  for (const key of ["sandbox", "token", "label"]) clean.searchParams.delete(key);
  window.history.replaceState(null, "", clean.toString());
  return store;
}
