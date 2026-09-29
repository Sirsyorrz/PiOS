import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import webpush from "web-push";
import { writePrivateJson } from "./private-file.ts";

/**
 * Web Push subscriptions for the PWA.
 *
 * A push endpoint is a capability URL: anyone holding it can wake the device,
 * so the file is 0600 next to the auth store and never leaves the daemon.
 * Subscriptions belong to a device, so revoking a device revokes its pushes.
 *
 * iOS only delivers Web Push to a PWA installed on the home screen, and drops
 * the subscription on reinstall or after long disuse. The client therefore
 * re-subscribes on every launch and the store dedupes on endpoint.
 */

const STORE_VERSION = 1;
/** Consecutive failures before a subscription is assumed dead and dropped. */
const MAX_FAILURES = 5;

export interface PushSubscriptionRecord {
  id: string;
  deviceId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
  lastSuccessAt: number | null;
  failures: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface StoreFile {
  version: number;
  vapid: VapidKeys;
  subscriptions: PushSubscriptionRecord[];
}

export interface PushMessage {
  title: string;
  body: string;
  /** Deep link opened when the notification is tapped. */
  url: string;
  /** Collapse key: a later settle replaces an unread one for the same session. */
  tag: string;
}

export class PushStore {
  private readonly path: string;
  private readonly subject: string;
  private data: StoreFile;

  constructor(path: string, subject = "mailto:pios@localhost") {
    this.path = path;
    this.subject = subject;
    this.data = load(path);
    // Keys are minted on first construction rather than on first subscribe:
    // the client asks for the public key before it can subscribe at all.
    if (!this.data.vapid.publicKey) {
      this.data.vapid = webpush.generateVAPIDKeys();
      this.persist();
    }
  }

  get publicKey(): string {
    return this.data.vapid.publicKey;
  }

  /**
   * Registers a subscription for a device.
   *
   * Keyed on the endpoint: a relaunched PWA hands back the same endpoint with
   * the same keys, and a stale record for it would only be pushed to twice.
   */
  subscribe(
    deviceId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    now = Date.now(),
  ): PushSubscriptionRecord {
    this.data.subscriptions = this.data.subscriptions.filter(
      (s) => s.endpoint !== subscription.endpoint,
    );
    const record: PushSubscriptionRecord = {
      id: randomBytes(8).toString("hex"),
      deviceId,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      createdAt: now,
      lastSuccessAt: null,
      failures: 0,
    };
    this.data.subscriptions.push(record);
    this.persist();
    return record;
  }

  unsubscribe(endpoint: string): boolean {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.data.subscriptions.length === before) return false;
    this.persist();
    return true;
  }

  /** Drops everything a device registered. Called when the device is revoked. */
  removeDevice(deviceId: string): void {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.deviceId !== deviceId);
    if (this.data.subscriptions.length !== before) this.persist();
  }

  list(): PushSubscriptionRecord[] {
    return [...this.data.subscriptions];
  }

  /**
   * Sends to every subscription except the devices given.
   *
   * A 404 or 410 means the browser dropped the subscription for good, so it is
   * removed immediately; anything else is transient until it has failed often
   * enough that keeping it only costs latency on every future send.
   */
  async send(message: PushMessage, skipDeviceIds: ReadonlySet<string> = new Set()): Promise<number> {
    const targets = this.data.subscriptions.filter((s) => !skipDeviceIds.has(s.deviceId));
    const payload = JSON.stringify(message);
    let delivered = 0;

    await Promise.all(
      targets.map(async (target) => {
        try {
          await webpush.sendNotification(
            { endpoint: target.endpoint, keys: target.keys },
            payload,
            {
              vapidDetails: {
                subject: this.subject,
                publicKey: this.data.vapid.publicKey,
                privateKey: this.data.vapid.privateKey,
              },
              TTL: 60 * 60,
              urgency: "high",
              topic: undefined,
            },
          );
          target.failures = 0;
          target.lastSuccessAt = Date.now();
          delivered += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          // Logged, never swallowed: a rejected VAPID JWT or a misconfigured
          // subject fails every send identically and silently otherwise.
          console.error(
            `[pios] push to ${new URL(target.endpoint).host} failed`,
            status ?? "",
            (error as { body?: string }).body ?? (error as Error).message,
          );
          if (status === 404 || status === 410) {
            this.unsubscribe(target.endpoint);
            return;
          }
          target.failures += 1;
          if (target.failures >= MAX_FAILURES) this.unsubscribe(target.endpoint);
        }
      }),
    );
    this.persist();
    return delivered;
  }

  private persist(): void {
    writePrivateJson(this.path, this.data);
  }
}

function load(path: string): StoreFile {
  const empty: StoreFile = {
    version: STORE_VERSION,
    vapid: { publicKey: "", privateKey: "" },
    subscriptions: [],
  };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
    if (parsed.version !== STORE_VERSION) {
      throw new Error(`unsupported push store version ${parsed.version}`);
    }
    return {
      version: STORE_VERSION,
      vapid: parsed.vapid ?? empty.vapid,
      subscriptions: parsed.subscriptions ?? [],
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return empty;
    throw error;
  }
}
