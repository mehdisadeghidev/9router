import { describe, it, expect, vi, beforeEach } from "vitest";

const { proxyAwareFetchMock, opencodeTlsFetchMock, OpencodeTlsUnavailableError } = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
  opencodeTlsFetchMock: vi.fn(),
  OpencodeTlsUnavailableError: class OpencodeTlsUnavailableError extends Error {
    constructor(msg) { super(msg); this.name = "OpencodeTlsUnavailableError"; }
  },
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: proxyAwareFetchMock,
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    opencodeTlsFetch: opencodeTlsFetchMock,
    OpencodeTlsUnavailableError,
    isOpencodeTlsAvailable: vi.fn(),
  };
});

const executeArgs = {
  model: "deepseek-v4.1-flash-free",
  body: { messages: [{ role: "user", content: "hi" }] },
  stream: true,
  credentials: {},
  log: { debug: () => {} },
};

describe("opencode fetchUpstream transport selection", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
    opencodeTlsFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  it("routes through opencodeTlsFetch with the resolved proxy URL", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    opencodeTlsFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const executor = new OpenCodeExecutor();
    const result = await executor.fetchUpstream(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", headers: {}, body: "{}" },
      null
    );

    expect(result.status).toBe(200);
    expect(opencodeTlsFetchMock).toHaveBeenCalledTimes(1);
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
    const [, init, opts] = opencodeTlsFetchMock.mock.calls[0];
    expect(init.body).toBe("{}");
    expect(opts.proxyUrl).toBe("");
  });

  it("passes the proxy URL to opencodeTlsFetch when a proxy is configured", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    opencodeTlsFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const executor = new OpenCodeExecutor();
    await executor.fetchUpstream(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", headers: {}, body: "{}" },
      { connectionProxyEnabled: true, connectionProxyUrl: "socks5://127.0.0.1:1080" }
    );

    const [, , opts] = opencodeTlsFetchMock.mock.calls[0];
    expect(opts.proxyUrl).toBe("socks5://127.0.0.1:1080");
  });

  it("falls back to proxyAwareFetch when opencodeTlsFetch throws OpencodeTlsUnavailableError", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    opencodeTlsFetchMock.mockRejectedValue(new OpencodeTlsUnavailableError("wreq-js missing"));
    proxyAwareFetchMock.mockResolvedValue(new Response("fallback", { status: 200 }));

    const executor = new OpenCodeExecutor();
    const result = await executor.fetchUpstream(
      "https://opencode.ai/inference/v1/chat/completions",
      { method: "POST", headers: {}, body: "{}" },
      null
    );

    expect(result.status).toBe(200);
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT catch non-unavailable errors from opencodeTlsFetch", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    opencodeTlsFetchMock.mockRejectedValue(new Error("socket hang up"));
    proxyAwareFetchMock.mockReset();

    const executor = new OpenCodeExecutor();
    await expect(
      executor.fetchUpstream("https://opencode.ai/x", { method: "POST", headers: {}, body: "{}" }, null)
    ).rejects.toThrow("socket hang up");

    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it("uses proxyAwareFetch for vercel relay instead of opencodeTlsFetch", async () => {
    const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
    proxyAwareFetchMock.mockResolvedValue(new Response("relay", { status: 200 }));

    const executor = new OpenCodeExecutor();
    const result = await executor.fetchUpstream(
      "https://opencode.ai/x",
      { method: "POST", headers: {}, body: "{}" },
      { vercelRelayUrl: "https://relay.example.com" }
    );

    expect(result.status).toBe(200);
    expect(opencodeTlsFetchMock).not.toHaveBeenCalled();
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
  });
});
