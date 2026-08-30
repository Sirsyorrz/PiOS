import { useEffect } from "react";
/**
 * Web Push registration for the PWA.
 *
 * iOS only delivers push to a web app installed on the home screen, and only
 * asks for permission from inside a user gesture, so enabling is a button and
 * never something the app decides on its own. The subscription is not durable:
 * a reinstall or a long idle period silently invalidates it, so the app
 * re-registers the endpoint with the daemon on every launch.
 */

export type PushState =
  | "unsupported"
  /** iOS gives a tab no PushManager at all; the user has to install first. */
  | "needs-install"
  | "denied"
  | "off"
  | "on";

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isStandalone() ? "unsupported" : "needs-install";
  if (Notification.permission === "denied") return "denied";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? "on" : "off";
}

/** Turns push on. Must be called from a user gesture: iOS ignores it otherwise. */
export async function enablePush(baseUrl: string, token: string): Promise<PushState> {
  if (!pushSupported()) return isStandalone() ? "unsupported" : "needs-install";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await subscribe(baseUrl, token);
  return "on";
}

export async function disablePush(baseUrl: string, token: string): Promise<PushState> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return "off";
  // The daemon is told first: a subscription it still holds after the browser
  // dropped it is a push that can never be delivered.
  await post(baseUrl, token, "/push/unsubscribe", { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
  return "off";
}

/**
 * Re-registers an existing subscription with the daemon.
 *
 * Cheap and idempotent: the daemon dedupes on endpoint. It exists because a
 * subscription can survive on the device while the daemon's copy is gone
 * (restored backup, new data dir), and the reverse is caught by delivery
 * failures.
 */
export async function refreshPush(baseUrl: string, token: string): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  if (!(await registration.pushManager.getSubscription())) return;
  await subscribe(baseUrl, token);
}

async function subscribe(baseUrl: string, token: string): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const response = await fetch(new URL("/push/key", baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`push unavailable (${response.status})`);
  const { publicKey } = (await response.json()) as { publicKey: string };

  // An existing subscription minted for a different key can never be decrypted
  // by this daemon, so it is replaced rather than reused.
  const existing = await registration.pushManager.getSubscription();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  if (existing && !sameKey(existing, applicationServerKey)) await existing.unsubscribe();

  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Safari requires this: a silent push is not deliverable to a web app.
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey as BufferSource,
    }));

  const json = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> };
  await post(baseUrl, token, "/push/subscribe", {
    endpoint: json.endpoint,
    keys: json.keys,
  });
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const applied = subscription.options.applicationServerKey;
  if (!applied) return false;
  const current = new Uint8Array(applied);
  return current.length === key.length && current.every((byte, i) => byte === key[i]);
}

async function post(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} failed (${response.status})`);
}

/** VAPID keys travel as base64url; `subscribe` wants raw bytes. */
function urlBase64ToUint8Array(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Re-registers this device's endpoint once per launch. Best effort. */
export function useKeepPushRegistered(baseUrl: string | null, token: string): void {
  useEffect(() => {
    if (!baseUrl) return;
    void refreshPush(baseUrl, token).catch(() => {
      // Notifications are best effort; a failure here must not block the app.
    });
  }, [baseUrl, token]);
}
