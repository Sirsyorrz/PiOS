import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Where pi session JSONL lives; sessions survive daemon restarts here. */
  sessionDir: string;
  /** Cap on a single upload, so a phone cannot fill the disk. */
  maxUploadBytes: number;
  /** How long a socket has to authenticate before it is closed. */
  helloTimeoutMs: number;
}

export const SERVER_VERSION = "0.0.0";

export function defaultConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  // Env override so a second daemon can run against a scratch dir without
  // faking HOME, which would also hide pi's own credentials from it.
  const dataDir = overrides.dataDir ?? process.env.PIOS_DATA_DIR ?? join(homedir(), ".pios");
  return {
    host: overrides.host ?? "0.0.0.0",
    port: overrides.port ?? 4111,
    dataDir,
    sessionDir: overrides.sessionDir ?? join(dataDir, "sessions"),
    maxUploadBytes: overrides.maxUploadBytes ?? 25 * 1024 * 1024,
    helloTimeoutMs: overrides.helloTimeoutMs ?? 5_000,
  };
}

export function authStorePath(config: ServerConfig): string {
  return join(config.dataDir, "auth.json");
}
