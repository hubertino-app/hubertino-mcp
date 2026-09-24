export const DEFAULT_API_URL = "https://hubertino.com";

export interface Config {
  /** Origin (plus optional path prefix) of the Hubertino app, without `/api/v1`. */
  apiUrl: string;
  /** `hub_live_…` key, or null when not configured (tools then explain how to set it). */
  apiKey: string | null;
  /** Where `download_export` saves files when the caller gives no directory. */
  downloadDir: string | null;
}

export class ConfigError extends Error {}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Normalise HUBERTINO_API_URL. Accepts `https://hubertino.com`,
 * `https://hubertino.com/` or `https://hubertino.com/api/v1` and returns the
 * base without a trailing slash or `/api/v1`. Plain http is only allowed for
 * loopback hosts, so an API key is never sent over the network unencrypted.
 */
export function normalizeApiUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim() || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`HUBERTINO_API_URL is not a valid URL: "${value}". Example: ${DEFAULT_API_URL}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`HUBERTINO_API_URL must be an https:// URL (got ${url.protocol}).`);
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ConfigError(
      "HUBERTINO_API_URL must use https:// (plain http is only allowed for localhost) so your API key is not sent unencrypted.",
    );
  }
  if (url.username || url.password) {
    throw new ConfigError("HUBERTINO_API_URL must not contain credentials. Put the key in HUBERTINO_API_KEY.");
  }
  url.search = "";
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  return `${url.origin}${path}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const key = (env.HUBERTINO_API_KEY ?? "").trim();
  const dir = (env.HUBERTINO_DOWNLOAD_DIR ?? "").trim();
  return {
    apiUrl: normalizeApiUrl(env.HUBERTINO_API_URL),
    apiKey: key || null,
    downloadDir: dir || null,
  };
}
