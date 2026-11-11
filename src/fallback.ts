import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.js";
import type {
  CapabilityConfig,
  MediaRequest,
  Provider,
  Provenance,
  Transcript,
  Visual,
} from "./types.js";
import { VIEError, safeError, checkAbort } from "./errors.js";
import { normalize } from "./providers/schema.js";
interface Health {
  failures: number;
  state: "closed" | "open" | "half-open";
  openedAt: number;
  active: number;
  nextAt: number;
}
export interface RequestBudget {
  requests: number;
  retries: number;
}
export class Orchestrator {
  private health = new Map<string, Health>();
  constructor(private c: Config) {}
  status() {
    return Object.fromEntries(
      [...this.health].map(([id, h]) => [id, { ...h }]),
    );
  }
  private record(p: Provider): Health {
    let h = this.health.get(p.id);
    if (!h) {
      h = { failures: 0, state: "closed", openedAt: 0, active: 0, nextAt: 0 };
      this.health.set(p.id, h);
    }
    return h;
  }
  async execute(
    config: CapabilityConfig,
    request: MediaRequest,
    budget: RequestBudget,
  ): Promise<{ value: Visual | Transcript; provenance: Provenance }> {
    const started = Date.now();
    const policy = config.policy ?? "user-only";
    const configured = config.providers ?? [];
    if (policy === "disabled")
      throw new VIEError("CONFIG", "Capability is disabled");
    const candidates =
      policy === "strict" ? configured.slice(0, 1) : configured;
    const providers = candidates.filter(
      (p) =>
        (policy !== "local-only" || p.location === "local") &&
        (!p.shared || (policy === "automatic" && this.c.sharedFallbackEnabled)),
    );
    const provenance: Provenance = {
      primary: configured[0]?.id ?? "none",
      attempts: [],
      fallbackUsed: false,
      durationMs: 0,
    };
    for (const provider of providers) {
      checkAbort(request.signal);
      const h = this.record(provider);
      if (h.state === "open") {
        if (Date.now() - h.openedAt < this.c.circuitRecoveryMs || h.active) {
          provenance.attempts.push({
            provider: provider.id,
            model: provider.model,
            status: "circuit-open",
            durationMs: 0,
          });
          continue;
        }
        h.state = "half-open";
      }
      for (let retry = 0; retry <= this.c.maxRetries; retry++) {
        const suppressed = () =>
          (h.state === "open" &&
            Date.now() - h.openedAt < this.c.circuitRecoveryMs) ||
          h.nextAt - Date.now() > this.c.timeoutMs;
        while (
          !suppressed() &&
          (h.active >= this.c.concurrency ||
            Date.now() < h.nextAt ||
            (h.state === "half-open" && h.active > 0))
        ) {
          await delay(
            Math.min(50, Math.max(1, h.nextAt - Date.now())),
            undefined,
            { signal: request.signal },
          ).catch(() => checkAbort(request.signal));
          checkAbort(request.signal);
        }
        checkAbort(request.signal);
        // State can change while this operation waits behind another request.
        const currentState = this.record(provider).state;
        if (suppressed()) {
          provenance.attempts.push({
            provider: provider.id,
            model: provider.model,
            status: currentState === "open" ? "circuit-open" : "failure",
            code: h.nextAt > Date.now() ? "RATE_LIMIT" : undefined,
            durationMs: 0,
          });
          break;
        }
        if (currentState === "open") h.state = "half-open";
        if (budget.requests >= this.c.maxRequests) {
          provenance.durationMs = Date.now() - started;
          throw Object.assign(
            new VIEError("BUDGET", "Provider request budget exhausted"),
            { provenance },
          );
        }
        budget.requests++;
        provenance.fallbackUsed ||= provider.id !== provenance.primary;
        h.active++;
        const t = Date.now();
        try {
          const signal = AbortSignal.any([
            request.signal,
            AbortSignal.timeout(this.c.timeoutMs),
          ]);
          let listener: () => void = () => {};
          const cancelled = new Promise<never>((_, reject) => {
            listener = () =>
              reject(
                new VIEError(
                  request.signal.aborted ? "CANCELLED" : "TIMEOUT",
                  "Provider operation stopped",
                  !request.signal.aborted,
                ),
              );
            signal.addEventListener("abort", listener, { once: true });
          });
          let value: Visual | Transcript;
          try {
            value = normalize(
              await Promise.race([
                provider.run({ ...request, signal }),
                cancelled,
              ]),
              request,
            );
          } finally {
            signal.removeEventListener("abort", listener);
          }
          provenance.attempts.push({
            provider: provider.id,
            model: provider.model,
            status: "success",
            durationMs: Date.now() - t,
          });
          h.failures = 0;
          h.state = "closed";
          provenance.successful = provider.id;
          provenance.model = provider.model;
          provenance.fallbackUsed = provider.id !== provenance.primary;
          provenance.durationMs = Date.now() - started;
          return { value, provenance };
        } catch (error) {
          checkAbort(request.signal);
          const e = safeError(error);
          provenance.attempts.push({
            provider: provider.id,
            model: provider.model,
            status: "failure",
            code: e.code,
            durationMs: Date.now() - t,
          });
          h.failures++;
          if (e.code === "RATE_LIMIT" && e.retryAfterMs !== undefined)
            h.nextAt = Math.max(h.nextAt, Date.now() + e.retryAfterMs);
          if (
            h.failures >= this.c.circuitThreshold ||
            h.state === "half-open"
          ) {
            h.state = "open";
            h.openedAt = Date.now();
          }
          if (
            !e.retryable ||
            retry === this.c.maxRetries ||
            budget.retries >= this.c.retryBudget ||
            h.state === "open"
          )
            break;
          budget.retries++;
          const wait =
            e.retryAfterMs ??
            this.c.backoffMs * 2 ** retry * (0.75 + Math.random() * 0.5);
          // Never shorten Retry-After; advance to a backup if the wait exceeds the call budget.
          h.nextAt = Date.now() + wait;
          if (wait > this.c.timeoutMs) break;
        } finally {
          h.active--;
        }
      }
    }
    const error = new VIEError(
      "EXHAUSTED",
      "No permitted provider succeeded; inspect health and capability warnings",
    );
    provenance.durationMs = Date.now() - started;
    Object.assign(error, { provenance });
    throw error;
  }
}
