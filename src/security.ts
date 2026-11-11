import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";
import { VIEError, checkAbort } from "./errors.js";

export function isPublicIP(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export async function validateURL(value: string, local = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VIEError("SECURITY", "Invalid URL");
  }
  if (url.username || url.password || url.hash)
    throw new VIEError(
      "SECURITY",
      "URL credentials and fragments are forbidden",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (local) {
    if (
      !["127.0.0.1", "::1", "localhost"].includes(host) ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new VIEError(
        "SECURITY",
        "Local providers must use loopback endpoints",
      );
  } else {
    if (url.protocol !== "https:")
      throw new VIEError("SECURITY", "External endpoints require HTTPS");
    const addresses = await lookup(host, { all: true }).catch(() => {
      throw new VIEError("NETWORK", "Endpoint DNS lookup failed", true);
    });
    if (!addresses.length || addresses.some((a) => !isPublicIP(a.address)))
      throw new VIEError("SECURITY", "Non-public destination blocked");
  }
  return url;
}
/** Revalidates DNS on the actual socket connection, preventing DNS rebinding. No redirects. */
export async function secureFetch(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal;
    local?: boolean;
  } = {},
) {
  checkAbort(options.signal);
  await validateURL(url, options.local);
  const agent = new Agent({
    connect: {
      lookup: (hostname, opts, callback) => {
        lookup(hostname, { all: true })
          .then((addresses) => {
            const allowed = addresses.filter((a) =>
              options.local
                ? ["127.0.0.1", "::1"].includes(a.address)
                : isPublicIP(a.address),
            );
            if (!allowed.length || allowed.length !== addresses.length) {
              callback(new Error("Destination blocked"), "", 4);
              return;
            }
            if (opts.all) callback(null, allowed);
            else callback(null, allowed[0]!.address, allowed[0]!.family);
          })
          .catch(() => callback(new Error("DNS failed"), "", 4));
      },
    },
  });
  try {
    const response = await undiciFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body as any,
      signal: options.signal,
      redirect: "manual",
      dispatcher: agent,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new VIEError(
        "SECURITY",
        "Redirects are forbidden; configure the final endpoint",
      );
    }
    return { response, close: () => agent.close() };
  } catch (error) {
    await agent.close();
    throw error;
  }
}
export async function boundedBody(
  response: { body: any },
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      checkAbort(signal);
      size += chunk.length;
      if (size > maxBytes)
        throw new VIEError("BUDGET", "Response exceeds byte limit");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await response.body?.cancel?.().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks);
}
