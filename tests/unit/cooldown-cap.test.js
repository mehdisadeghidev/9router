import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

const NOW = new Date("2026-10-22T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.getProviderConnections.mockResolvedValue([{ id: "acct", backoffLevel: 0 }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Provider-reported cooldowns are capped", () => {
  const lockMs = () => {
    const [, update] = db.updateProviderConnection.mock.calls[0];
    const key = Object.keys(update).find((k) => k.startsWith("modelLock_"));
    return new Date(update[key]).getTime() - NOW.getTime();
  };

  it("caps a far-future reset instead of parking the account for days", async () => {
    const sixDaysOut = NOW.getTime() + 6 * 24 * 60 * 60 * 1000;
    const result = await markAccountUnavailable("acct", 429, "quota exceeded", "antigravity", "m", sixDaysOut);

    expect(result.shouldFallback).toBe(true);
    expect(lockMs()).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it.each(["antigravity", "codex", "openai"])("applies the same cap to %s", async (provider) => {
    const sixDaysOut = NOW.getTime() + 6 * 24 * 60 * 60 * 1000;
    await markAccountUnavailable("acct", 429, "rate limited", provider, "m", sixDaysOut);
    expect(lockMs()).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  });

  it("leaves a reset shorter than the cap untouched", async () => {
    const twoMinutes = NOW.getTime() + 2 * 60 * 1000;
    await markAccountUnavailable("acct", 429, "rate limited", "antigravity", "m", twoMinutes);
    expect(lockMs()).toBe(2 * 60 * 1000);
  });

  it("falls back to the exponential backoff when no reset is reported", async () => {
    await markAccountUnavailable("acct", 429, "rate limited", "openai", "m");
    expect(lockMs()).toBeGreaterThan(0);
    expect(lockMs()).toBeLessThanOrEqual(MAX_RATE_LIMIT_COOLDOWN_MS);
  });
});
