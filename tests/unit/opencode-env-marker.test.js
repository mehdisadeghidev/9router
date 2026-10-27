import { describe, expect, it } from "vitest";
import { applyEnvFingerprint } from "../../open-sse/utils/opencodeFingerprint.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const WORKDIR_LINE = "Working directory:";
const ROOT_LINE = "Workspace root folder:";

function envCount(text) {
  return String(text || "").split("<env>").length - 1;
}

function chatBody(overrides = {}) {
  return {
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function responsesBody(overrides = {}) {
  return {
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    ...overrides,
  };
}

describe("applyEnvFingerprint", () => {
  it("declares the workspace root next to the working directory", () => {
    const body = chatBody();
    applyEnvFingerprint(body, false);
    const system = body.messages[0].content;
    expect(system).toContain(WORKDIR_LINE);
    expect(system).toContain(ROOT_LINE);
    expect(system).toContain("</env>");
  });

  it("adds a system message carrying the env block when the chat body has none", () => {
    const body = chatBody();
    expect(applyEnvFingerprint(body, false)).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("<env>");
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends the env block to an existing string system message", () => {
    const body = chatBody({
      messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }],
    });
    applyEnvFingerprint(body, false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content.startsWith("You are helpful.")).toBe(true);
    expect(body.messages[0].content.endsWith("</env>")).toBe(true);
  });

  // Block arrays keep their shape: the marker joins the last text block.
  it("appends the env block to a part array system message", () => {
    const body = chatBody({
      messages: [
        { role: "system", content: [{ type: "text", text: "You are helpful." }] },
        { role: "user", content: "hi" },
      ],
    });
    applyEnvFingerprint(body, false);
    expect(body.messages[0].content).toHaveLength(1);
    expect(body.messages[0].content[0].text.startsWith("You are helpful.")).toBe(true);
    expect(body.messages[0].content[0].text).toContain("<env>");
    expect(body.messages[0].content[0].text.endsWith("</env>")).toBe(true);
  });

  it("appends the env block to a claude system string", () => {
    const body = { system: "You are Claude Code.", messages: [{ role: "user", content: "hi" }] };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(true);
    expect(body.system.startsWith("You are Claude Code.")).toBe(true);
    expect(body.system.endsWith("</env>")).toBe(true);
    expect(body.messages).toHaveLength(1);
  });

  it("appends the env block to a claude system array", () => {
    const body = {
      system: [{ type: "text", text: "You are Claude Code." }],
      messages: [{ role: "user", content: "hi" }],
    };
    applyEnvFingerprint(body, false, { claude: true });
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text.startsWith("You are Claude Code.")).toBe(true);
    expect(body.system[0].text).toContain("<env>");
  });

  it("uses instructions for Responses bodies", () => {
    const body = responsesBody();
    applyEnvFingerprint(body, true);
    expect(body.instructions).toContain("<env>");
    expect(body.input).toHaveLength(1);
  });

  it("appends the env block to existing Responses instructions", () => {
    const body = responsesBody({ instructions: "You are Codex." });
    applyEnvFingerprint(body, true);
    expect(body.instructions.startsWith("You are Codex.")).toBe(true);
    expect(body.instructions.endsWith("</env>")).toBe(true);
  });

  // A real opencode client already sends the marker; doubling it would alter
  // the prompt.
  it("leaves an existing env block untouched and stays idempotent", () => {
    const existing = "Custom prompt\n\n<env>\n  Working directory: /workspace\n  Workspace root folder: /workspace\n</env>";
    const body = chatBody({ messages: [{ role: "system", content: existing }, { role: "user", content: "hi" }] });
    expect(applyEnvFingerprint(body, false)).toBe(false);
    expect(body.messages[0].content).toBe(existing);
    expect(envCount(body.messages[0].content)).toBe(1);
  });

  it("does not touch a claude array that already holds an env block", () => {
    const body = {
      system: [
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: "<env>\n  Working directory: /workspace\n</env>" },
      ],
      messages: [],
    };
    expect(applyEnvFingerprint(body, false, { claude: true })).toBe(false);
    expect(body.system).toHaveLength(2);
  });

  it("ignores nullish and non-object bodies", () => {
    expect(() => applyEnvFingerprint(null, false)).not.toThrow();
    expect(() => applyEnvFingerprint(undefined, false)).not.toThrow();
    expect(() => applyEnvFingerprint("text", false)).not.toThrow();
    expect(applyEnvFingerprint(null, false)).toBe(false);
  });
});

describe("OpenCodeExecutor env marker wiring", () => {
  const executor = new OpenCodeExecutor();

  it("adds the env block on the Chat Completions lane", () => {
    const out = executor.transformRequest("nemotron-3-ultra-free", chatBody(), true, {});
    const system = out.messages.filter((message) => message.role === "system");
    expect(system).toHaveLength(1);
    expect(system[0].content).toContain("<env>");
    expect(system[0].content).toContain(WORKDIR_LINE);
    expect(system[0].content).toContain(ROOT_LINE);
    expect(system[0].content).toContain("</env>");
  });

  it("keeps one system message when the tool fingerprint already added one", () => {
    const out = executor.transformRequest("nemotron-3-ultra-free", chatBody(), true, {});
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toMatch(/Do not call the `read` or `shell` tools/);
    expect(envCount(out.messages[0].content)).toBe(1);
  });

  it("adds the env block to Responses instructions", () => {
    const out = executor.transformRequest("muse-spark-1.3-contributor-free", responsesBody(), true, {});
    expect(out.instructions).toContain("<env>");
    expect(out.instructions).toContain(WORKDIR_LINE);
    expect(out.input).toHaveLength(1);
  });

  it("adds the env block to claude-shaped bodies", () => {
    const out = executor.transformRequest("nemotron-3-ultra-free", {
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "hi" }],
    }, true, {});
    expect(out.system).toContain("You are Claude Code.");
    expect(out.system).toContain(WORKDIR_LINE);
    expect(out.messages).toHaveLength(1);
  });

  it("does not change the resolved endpoint", () => {
    expect(executor.buildUrl("nemotron-3-ultra-free")).toBe("https://opencode.ai/inference/v1/chat/completions");
  });
});
