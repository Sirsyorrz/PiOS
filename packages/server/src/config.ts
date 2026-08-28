import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /**
   * Where pi session JSONL lives. Defaults to pi's own directory so the TUI
   * and PiOS see one set of sessions and can resume each other's work.
   */
  sessionDir: string;
  /** Cap on a single upload, so a phone cannot fill the disk. */
  maxUploadBytes: number;
  /** How long a socket has to authenticate before it is closed. */
  helloTimeoutMs: number;
  /**
   * How long an activity report stands for. Longer than the client's 25s
   * report interval, so one dropped report does not cost a notification.
   */
  activityTtlMs: number;
  /** `mailto:` or `https:` identity sent to push services in the VAPID JWT. */
  pushSubject: string;
  /**
   * Built PWA served by the daemon, or null to serve no app at all.
   *
   * Same origin as the API on purpose: a service worker, Web Push, and an
   * installable home-screen app all need one secure origin, and one origin
   * also means no CORS and no endpoint picker guessing a second port.
   */
  webDir: string | null;
  /**
   * Origin a phone actually uses, when something is proxying the daemon.
   * Advertised ahead of the addresses discovered on the interfaces.
   */
  publicUrl: string | null;
}

export const SERVER_VERSION = "0.0.0";

/**
 * Fallback VAPID subject.
 *
 * Push services validate it: Apple rejects a JWT whose subject is a `mailto:`
 * at an unresolvable domain (`BadJwtToken`), which is what any `localhost`
 * default would produce. A real https URL is accepted everywhere.
 */
const DEFAULT_PUSH_SUBJECT = "https://github.com/earendil-works/pi";

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  // Env override so a second daemon can run against a scratch dir without
  // faking HOME, which would also hide pi's own credentials from it.
  const dataDir = overrides.dataDir ?? process.env.PIOS_DATA_DIR ?? join(homedir(), ".pios");
  const publicUrl = overrides.publicUrl ?? process.env.PIOS_PUBLIC_URL ?? null;
  return {
    host: overrides.host ?? "0.0.0.0",
    port: overrides.port ?? 4111,
    dataDir,
    sessionDir:
      overrides.sessionDir ??
      process.env.PIOS_SESSION_DIR ??
      join(homedir(), ".pi", "agent", "sessions"),
    maxUploadBytes: overrides.maxUploadBytes ?? 25 * 1024 * 1024,
    helloTimeoutMs: overrides.helloTimeoutMs ?? 5_000,
    activityTtlMs: overrides.activityTtlMs ?? 45_000,
    webDir: overrides.webDir !== undefined ? overrides.webDir : defaultWebDir(),
    publicUrl,
    // The daemon's own https origin identifies it better than a generic URL,
    // and is the one address the operator already knows is real.
    pushSubject:
      overrides.pushSubject ??
      process.env.PIOS_PUSH_SUBJECT ??
      (publicUrl?.startsWith("https://") ? publicUrl : DEFAULT_PUSH_SUBJECT),
  };
}

/** The workspace build output, when the daemon is running from the repo. */
function defaultWebDir(): string | null {
  if (process.env.PIOS_WEB_DIR) return process.env.PIOS_WEB_DIR;
  const candidate = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));
  return existsSync(join(candidate, "index.html")) ? candidate : null;
}

export function pushStorePath(config: ServerConfig): string {
  return join(config.dataDir, "push.json");
}

export function authStorePath(config: ServerConfig): string {
  return join(config.dataDir, "auth.json");
}
