import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../src/fallback.js";
import { configure } from "../src/config.js";
import { VIEError } from "../src/errors.js";
import { provider } from "./helpers.js";
import type { MediaRequest, Provider } from "../src/types.js";
const request = (): MediaRequest => ({
  capability: "vision",
  files: [],
  timestamps: [0],
  prompt: "test",
  signal: AbortSignal.timeout(2000),
});
describe("deterministic fallback and policy cases", () => {
  it("honors shared rate cooldown even when retries are disabled", async () => {
    const limited = vi.fn(async () => {
      throw new VIEError("RATE_LIMIT", "limited", true, 10000);
    });
    const manager = new Orchestrator(
      configure({ timeoutMs: 100, maxRetries: 0, circuitThreshold: 100 }),
    );
    const providers = [provider("limited", limited), provider("backup")];
    await manager.execute({ providers }, request(), {
      requests: 0,
      retries: 0,
    });
    const result = await manager.execute({ providers }, request(), {
      requests: 0,
      retries: 0,
    });
    expect(limited).toHaveBeenCalledOnce();
    expect(result.provenance.successful).toBe("backup");
  });
  it("does not flood a newly open circuit from already queued calls", async () => {
    const bad = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new VIEError("AUTH", "bad");
    });
    const manager = new Orchestrator(
      configure({ concurrency: 1, circuitThreshold: 1, maxRetries: 0 }),
    );
    const providers = [provider("bad", bad), provider("backup")];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        manager.execute({ providers }, request(), { requests: 0, retries: 0 }),
      ),
    );
    expect(bad).toHaveBeenCalledOnce();
  });
  it("uses primary without backup", async () => {
    const backup = vi.fn();
    const result = await new Orchestrator(configure()).execute(
      { providers: [provider(), provider("backup", backup)] },
      request(),
      { requests: 0, retries: 0 },
    );
    expect(result.provenance.fallbackUsed).toBe(false);
    expect(backup).not.toHaveBeenCalled();
  });
  it.each([
    ["RATE_LIMIT", true],
    ["TIMEOUT", true],
    ["NETWORK", true],
    ["AUTH", false],
    ["MALFORMED", false],
    ["MODEL_MISSING", false],
  ] as const)("bounds retries and switches on %s", async (code, retryable) => {
    const bad = vi.fn(async () => {
      throw new VIEError(code, "safe failure", retryable);
    });
    const manager = new Orchestrator(
      configure({ maxRetries: 1, backoffMs: 1, circuitThreshold: 10 }),
    );
    const b = { requests: 0, retries: 0 };
    const r = await manager.execute(
      { providers: [provider("primary", bad), provider("backup")] },
      request(),
      b,
    );
    expect(bad).toHaveBeenCalledTimes(retryable ? 2 : 1);
    expect(r.provenance.successful).toBe("backup");
    expect(r.provenance.attempts).toHaveLength(retryable ? 3 : 2);
  });
  it("uses Qwen then Nemotron only after automatic opt-in", async () => {
    const shared1 = {
      ...provider("qwen", async () => {
        throw new VIEError("NETWORK", "unavailable");
      }),
      shared: true,
    };
    const shared2 = { ...provider("nemotron"), shared: true };
    const manager = new Orchestrator(
      configure({ sharedFallbackEnabled: true, maxRetries: 0 }),
    );
    const r = await manager.execute(
      {
        policy: "automatic",
        providers: [
          provider("bad", async () => {
            throw new VIEError("AUTH", "bad auth");
          }),
          shared1,
          shared2,
        ],
      },
      request(),
      { requests: 0, retries: 0 },
    );
    expect(r.provenance.successful).toBe("nemotron");
    expect(r.provenance.attempts.map((a) => a.provider)).toEqual([
      "bad",
      "qwen",
      "nemotron",
    ]);
    const qwenResult = await manager.execute(
      {
        policy: "automatic",
        providers: [{ ...provider("qwen-ok"), shared: true }, shared2],
      },
      request(),
      { requests: 0, retries: 0 },
    );
    expect(qwenResult.provenance.successful).toBe("qwen-ok");
  });
  it.each(["local-only", "disabled", "user-only", "strict"] as const)(
    "prevents prohibited shared transmission with %s",
    async (policy) => {
      const run = vi.fn(async () => ({ description: "must not run" }));
      const p: Provider = { ...provider("shared", run), shared: true };
      await expect(
        new Orchestrator(configure()).execute(
          { policy, providers: [p] },
          request(),
          { requests: 0, retries: 0 },
        ),
      ).rejects.toBeInstanceOf(VIEError);
      expect(run).not.toHaveBeenCalled();
    },
  );
  it("local-only chooses a local runtime; strict never switches providers", async () => {
    const external = vi.fn();
    const manager = new Orchestrator(configure());
    const r = await manager.execute(
      {
        policy: "local-only",
        providers: [
          provider("external", external),
          { ...provider("local"), location: "local" },
        ],
      },
      request(),
      { requests: 0, retries: 0 },
    );
    expect(external).not.toHaveBeenCalled();
    expect(r.provenance.successful).toBe("local");
    const backup = vi.fn();
    await expect(
      manager.execute(
        {
          policy: "strict",
          providers: [
            provider("bad", async () => {
              throw new VIEError("AUTH", "bad");
            }),
            provider("backup", backup),
          ],
        },
        request(),
        { requests: 0, retries: 0 },
      ),
    ).rejects.toMatchObject({ code: "EXHAUSTED" });
    expect(backup).not.toHaveBeenCalled();
  });
  it("opens and recovers the circuit breaker", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new VIEError("NETWORK", "failed"))
      .mockResolvedValue({ description: "recovered" });
    const manager = new Orchestrator(
      configure({ circuitThreshold: 1, circuitRecoveryMs: 5, maxRetries: 0 }),
    );
    await expect(
      manager.execute({ providers: [provider("primary", run)] }, request(), {
        requests: 0,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: "EXHAUSTED" });
    expect(manager.status().primary!.state).toBe("open");
    await new Promise((r) => setTimeout(r, 10));
    await manager.execute(
      { providers: [provider("primary", run)] },
      request(),
      { requests: 0, retries: 0 },
    );
    expect(manager.status().primary!.state).toBe("closed");
  });
  it("respects Retry-After, global retry and request budgets, cancellation", async () => {
    const bad = provider("rate-limit", async () => {
      throw new VIEError("RATE_LIMIT", "limited", true, 10000);
    });
    const manager = new Orchestrator(
      configure({ timeoutMs: 100, maxRetries: 3, backoffMs: 1 }),
    );
    const b = { requests: 0, retries: 0 };
    await expect(
      manager.execute({ providers: [bad] }, request(), b),
    ).rejects.toMatchObject({ code: "EXHAUSTED" });
    expect(b.requests).toBe(1);
    await expect(
      new Orchestrator(configure({ maxRequests: 1 })).execute(
        {
          providers: [
            provider("bad", async () => {
              throw new VIEError("AUTH", "bad");
            }),
            provider(),
          ],
        },
        request(),
        { requests: 0, retries: 0 },
      ),
    ).rejects.toMatchObject({ code: "BUDGET" });
    await expect(
      manager.execute(
        { providers: [provider()] },
        { ...request(), signal: AbortSignal.abort() },
        { requests: 0, retries: 0 },
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("enforces per-provider concurrency and hard timeout even for a stalled plugin", async () => {
    let active = 0,
      peak = 0;
    const p = provider("scheduled", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { description: "ok" };
    });
    const manager = new Orchestrator(
      configure({ concurrency: 1, maxRetries: 0 }),
    );
    await Promise.all(
      Array.from({ length: 4 }, () =>
        manager.execute({ providers: [p] }, request(), {
          requests: 0,
          retries: 0,
        }),
      ),
    );
    expect(peak).toBe(1);
    await expect(
      new Orchestrator(configure({ timeoutMs: 10, maxRetries: 0 })).execute(
        { providers: [provider("stalled", () => new Promise(() => {}))] },
        request(),
        { requests: 0, retries: 0 },
      ),
    ).rejects.toMatchObject({ code: "EXHAUSTED" });
  });
});
