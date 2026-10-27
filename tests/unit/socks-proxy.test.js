import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSocksProxyUrl,
  parseSocksProxyUrl,
  SOCKS_PROTOCOLS,
} from "../../open-sse/utils/socksTunnel.js";
import { normalizeProxyUrl, resolveEffectiveProxyUrl } from "../../open-sse/utils/proxyResolution.js";

describe("socks proxy detection", () => {
  it("recognises every socks scheme the pool validator accepts", () => {
    for (const scheme of ["socks", "socks4", "socks4a", "socks5", "socks5h"]) {
      expect(isSocksProxyUrl(`${scheme}://127.0.0.1:1080`)).toBe(true);
    }
  });

  it("covers the same schemes as the pool validator", () => {
    expect([...SOCKS_PROTOCOLS].sort()).toEqual([
      "socks4:",
      "socks4a:",
      "socks5:",
      "socks5h:",
      "socks:",
    ]);
  });

  it("is case insensitive", () => {
    expect(isSocksProxyUrl("SOCKS5://127.0.0.1:1080")).toBe(true);
  });

  it("rejects http, https and malformed values", () => {
    expect(isSocksProxyUrl("http://127.0.0.1:7890")).toBe(false);
    expect(isSocksProxyUrl("https://127.0.0.1:7890")).toBe(false);
    expect(isSocksProxyUrl("127.0.0.1:1080")).toBe(false);
    expect(isSocksProxyUrl("")).toBe(false);
    expect(isSocksProxyUrl(null)).toBe(false);
  });
});

describe("socks proxy parsing", () => {
  it("maps the scheme to a version and a DNS mode", () => {
    expect(parseSocksProxyUrl("socks5://h:1080")).toMatchObject({ version: 5, remoteDns: false });
    expect(parseSocksProxyUrl("socks5h://h:1080")).toMatchObject({ version: 5, remoteDns: true });
    expect(parseSocksProxyUrl("socks4://h:1080")).toMatchObject({ version: 4, remoteDns: false });
    expect(parseSocksProxyUrl("socks4a://h:1080")).toMatchObject({ version: 4, remoteDns: true });
  });

  it("defaults the port to 1080", () => {
    expect(parseSocksProxyUrl("socks5://proxy.example.com").port).toBe(1080);
  });

  it("decodes credentials and strips IPv6 brackets", () => {
    const parsed = parseSocksProxyUrl("socks5://user%40mail:p%3Ass@[::1]:1081");
    expect(parsed.username).toBe("user@mail");
    expect(parsed.password).toBe("p:ss");
    expect(parsed.host).toBe("::1");
    expect(parsed.port).toBe(1081);
  });
});

describe("proxy url normalization", () => {
  it("keeps an explicit socks scheme instead of prefixing http", () => {
    expect(normalizeProxyUrl("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
    expect(normalizeProxyUrl("socks4a://127.0.0.1:1080")).toBe("socks4a://127.0.0.1:1080");
  });

  it("still prefixes a bare host:port", () => {
    expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });
});

describe("egress identity for a socks pool", () => {
  const target = "https://opencode.ai/inference/v1/chat/completions";

  it("resolves the socks url unchanged", () => {
    const opts = { enabled: true, url: "socks5://127.0.0.1:1080" };
    expect(resolveEffectiveProxyUrl(target, opts)).toEqual({
      url: "socks5://127.0.0.1:1080",
      source: "connection",
    });
  });

  it("does not collide with an http pool on the same host and port", async () => {
    const { identifyFixedEgress } = await import("../../open-sse/utils/egress.js");
    const socks = identifyFixedEgress(target, { enabled: true, url: "socks5://127.0.0.1:1080" });
    const http = identifyFixedEgress(target, { enabled: true, url: "http://127.0.0.1:1080" });
    expect(socks.kind).toBe("proxy");
    expect(socks.id).not.toBe(http.id);
  });
});

describe("proxy transport routing", () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    globalThis.fetch = vi.fn((...args) => {
      fetchCalls.push(args);
      return Promise.resolve(new Response("ok", { status: 200 }));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not hand a socks url to the undici dispatcher", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    await expect(
      proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", {}, {
        enabled: true,
        url: "socks5://127.0.0.1:1",
        strictProxy: true,
      }),
    ).rejects.toThrow(/strictProxy|ECONNREFUSED/);

    const usedDispatcher = fetchCalls.some(([, init]) => init && typeof init === "object" && "dispatcher" in init);
    expect(usedDispatcher).toBe(false);
  });

  it("never reports a socks pool as a direct-IP leak", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    const response = await proxyAwareFetch("https://opencode.ai/inference/v1/chat/completions", {}, {
      enabled: true,
      url: "socks5://127.0.0.1:1",
    });
    expect(response.status).toBe(200);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0][1].dispatcher).toBeUndefined();
  });
});

describe("proxy pool test endpoint", () => {
  it("reports a socks url through the tunnel instead of undici", async () => {
    const { testProxyUrl } = await import("../../src/lib/network/proxyTest.js");
    const result = await testProxyUrl({
      proxyUrl: "socks5://127.0.0.1:1",
      testUrl: "https://example.com/",
      timeoutMs: 1500,
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).not.toMatch(/Invalid URL protocol/);
  });
});
