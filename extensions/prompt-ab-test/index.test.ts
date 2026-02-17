import { beforeEach, describe, expect, it, vi } from "vitest";
import register, {
  assignVariant,
  hashString,
  selectVariant,
  type AbTestExperiment,
  type PromptAbTestConfig,
  type PromptVariant,
} from "./index.js";

// ============================================================================
// Unit tests for pure helpers
// ============================================================================

describe("hashString", () => {
  it("returns a non-negative integer", () => {
    expect(hashString("hello")).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hashString("hello"))).toBe(true);
  });

  it("is deterministic — same input yields same output", () => {
    expect(hashString("session-abc:experiment-1")).toBe(hashString("session-abc:experiment-1"));
  });

  it("produces different values for different inputs", () => {
    expect(hashString("session-abc:experiment-1")).not.toBe(
      hashString("session-xyz:experiment-1"),
    );
    expect(hashString("session-abc:experiment-1")).not.toBe(
      hashString("session-abc:experiment-2"),
    );
  });

  it("handles empty string without throwing", () => {
    expect(() => hashString("")).not.toThrow();
  });
});

describe("selectVariant", () => {
  const variants: PromptVariant[] = [
    { id: "control", weight: 1 },
    { id: "variant-a", weight: 1 },
    { id: "variant-b", weight: 1 },
  ];

  it("throws when variants array is empty", () => {
    expect(() => selectVariant([], 42)).toThrow();
  });

  it("always returns the only variant when there is one", () => {
    const single: PromptVariant[] = [{ id: "solo", weight: 1 }];
    for (let seed = 0; seed < 50; seed++) {
      expect(selectVariant(single, seed).id).toBe("solo");
    }
  });

  it("is deterministic — same seed produces same variant", () => {
    const seed = 123456;
    expect(selectVariant(variants, seed).id).toBe(selectVariant(variants, seed).id);
  });

  it("returns a valid variant for many different seeds", () => {
    const ids = new Set(variants.map((v) => v.id));
    for (let seed = 0; seed < 1000; seed++) {
      const result = selectVariant(variants, seed);
      expect(ids.has(result.id)).toBe(true);
    }
  });

  it("respects zero-weight variants (never selects them)", () => {
    const pool: PromptVariant[] = [
      { id: "always", weight: 1 },
      { id: "never", weight: 0 },
    ];
    for (let seed = 0; seed < 1000; seed++) {
      expect(selectVariant(pool, seed).id).toBe("always");
    }
  });

  it("falls back to first variant when all weights are zero", () => {
    const pool: PromptVariant[] = [
      { id: "first", weight: 0 },
      { id: "second", weight: 0 },
    ];
    expect(selectVariant(pool, 0).id).toBe("first");
  });

  it("roughly honours weight ratios over many seeds", () => {
    const pool: PromptVariant[] = [
      { id: "heavy", weight: 9 },
      { id: "light", weight: 1 },
    ];
    const counts: Record<string, number> = { heavy: 0, light: 0 };
    for (let seed = 0; seed < 10_000; seed++) {
      counts[selectVariant(pool, seed).id]++;
    }
    // heavy should be selected ~90% of the time; allow ±5% tolerance.
    const heavyRatio = counts.heavy / 10_000;
    expect(heavyRatio).toBeGreaterThan(0.85);
    expect(heavyRatio).toBeLessThan(0.95);
  });

  it("uses default weight of 1 when weight is omitted", () => {
    const pool: PromptVariant[] = [{ id: "a" }, { id: "b" }];
    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let seed = 0; seed < 1000; seed++) {
      counts[selectVariant(pool, seed).id]++;
    }
    // Should be roughly 50/50 — both should appear at least once.
    expect(counts.a).toBeGreaterThan(0);
    expect(counts.b).toBeGreaterThan(0);
  });
});

describe("assignVariant", () => {
  const variants: PromptVariant[] = [
    { id: "control", weight: 1 },
    { id: "variant-a", weight: 1 },
  ];

  it("is deterministic for the same session+experiment", () => {
    const v1 = assignVariant("sess-123", "exp-tone", variants);
    const v2 = assignVariant("sess-123", "exp-tone", variants);
    expect(v1.id).toBe(v2.id);
  });

  it("produces different assignments for different sessions", () => {
    // With equal weights and two variants, different sessions will eventually
    // hit different buckets. We just check it doesn't always return the same
    // variant across 50 different session keys.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(assignVariant(`session-${i}`, "exp-tone", variants).id);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("is stable across repeated calls (no side effects)", () => {
    for (let i = 0; i < 10; i++) {
      const a = assignVariant("stable-sess", "exp-safety", variants);
      const b = assignVariant("stable-sess", "exp-safety", variants);
      expect(a.id).toBe(b.id);
    }
  });
});

// ============================================================================
// Integration tests for the plugin registration
// ============================================================================

type HookHandler = (...args: unknown[]) => unknown;

function makeApi(pluginConfig: PromptAbTestConfig = {}) {
  const hooks: Record<string, HookHandler> = {};
  const api = {
    id: "prompt-ab-test",
    name: "Prompt A/B Test",
    pluginConfig,
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn((hookName: string, handler: HookHandler) => {
      hooks[hookName] = handler;
    }),
  };
  return { api, hooks };
}

describe("plugin registration", () => {
  it("logs idle and returns early when no experiments are configured", () => {
    const { api } = makeApi({ experiments: [] });
    register(api as never);
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("idle"));
    expect(api.on).not.toHaveBeenCalled();
  });

  it("logs idle when all experiments are disabled", () => {
    const { api } = makeApi({
      experiments: [
        { id: "exp-1", enabled: false, variants: [{ id: "control" }] },
      ],
    });
    register(api as never);
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("idle"));
  });

  it("skips experiments with no variants and warns", () => {
    const { api } = makeApi({
      experiments: [
        // @ts-expect-error intentionally malformed for test
        { id: "bad-exp", variants: [] },
        { id: "good-exp", variants: [{ id: "control" }] },
      ],
    });
    register(api as never);
    expect(api.logger.warn).toHaveBeenCalledWith(expect.stringContaining("bad-exp"));
    expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining("good-exp"));
  });

  it("registers before_prompt_build, agent_end, and gateway_start hooks", () => {
    const { api } = makeApi({
      experiments: [{ id: "exp-1", variants: [{ id: "control" }, { id: "variant-a" }] }],
    });
    register(api as never);
    const registeredHooks = api.on.mock.calls.map(([name]) => name);
    expect(registeredHooks).toContain("before_prompt_build");
    expect(registeredHooks).toContain("agent_end");
    expect(registeredHooks).toContain("gateway_start");
  });
});

describe("before_prompt_build hook", () => {
  const twoVariantConfig: PromptAbTestConfig = {
    experiments: [
      {
        id: "identity-test",
        variants: [
          { id: "control", weight: 1 },
          { id: "variant-a", weight: 1, prependContext: "You are Alex, a concise assistant." },
        ],
      },
    ],
  };

  it("returns undefined when assigned to control (no overrides)", async () => {
    const { api, hooks } = makeApi(twoVariantConfig);
    register(api as never);

    // Run before_prompt_build across many session keys and verify that control
    // variants (no prependContext/systemPrompt) return undefined.
    let foundControl = false;
    for (let i = 0; i < 100; i++) {
      const result = await hooks.before_prompt_build(
        { prompt: "hi", messages: [] },
        { sessionKey: `sess-${i}`, agentId: "agent-1" },
      );
      const variant = assignVariant(`sess-${i}`, "identity-test", [
        { id: "control", weight: 1 },
        { id: "variant-a", weight: 1, prependContext: "You are Alex, a concise assistant." },
      ]);
      if (variant.id === "control") {
        expect(result).toBeUndefined();
        foundControl = true;
      }
    }
    // Sanity check: we should have hit a control assignment among 100 sessions.
    expect(foundControl).toBe(true);
  });

  it("returns prependContext for variant-a sessions", async () => {
    const { api, hooks } = makeApi(twoVariantConfig);
    register(api as never);

    let foundVariantA = false;
    for (let i = 0; i < 100; i++) {
      const sessionKey = `probe-${i}`;
      const expectedVariant = assignVariant(sessionKey, "identity-test", [
        { id: "control", weight: 1 },
        { id: "variant-a", weight: 1, prependContext: "You are Alex, a concise assistant." },
      ]);
      const result = (await hooks.before_prompt_build(
        { prompt: "hello", messages: [] },
        { sessionKey, agentId: "agent-1" },
      )) as { prependContext?: string; systemPrompt?: string } | undefined;

      if (expectedVariant.id === "variant-a") {
        expect(result).toBeDefined();
        expect(result?.prependContext).toBe("You are Alex, a concise assistant.");
        expect(result?.systemPrompt).toBeUndefined();
        foundVariantA = true;
      }
    }
    expect(foundVariantA).toBe(true);
  });

  it("is session-stable — repeated calls return the same result", async () => {
    const { api, hooks } = makeApi(twoVariantConfig);
    register(api as never);

    const sessionKey = "stable-session-xyz";
    const ctx = { sessionKey, agentId: "agent-1" };
    const event = { prompt: "hi", messages: [] };

    const first = await hooks.before_prompt_build(event, ctx);
    for (let i = 0; i < 10; i++) {
      const subsequent = await hooks.before_prompt_build(event, ctx);
      expect(subsequent).toEqual(first);
    }
  });

  it("returns systemPrompt override when variant specifies one", async () => {
    const fullOverrideConfig: PromptAbTestConfig = {
      experiments: [
        {
          id: "full-prompt-test",
          variants: [
            { id: "control", weight: 0 }, // disabled so variant-b always wins
            {
              id: "variant-b",
              weight: 1,
              systemPrompt: "You are a specialized coding assistant.",
            },
          ],
        },
      ],
    };
    const { api, hooks } = makeApi(fullOverrideConfig);
    register(api as never);

    const result = (await hooks.before_prompt_build(
      { prompt: "help", messages: [] },
      { sessionKey: "any-session", agentId: "agent-1" },
    )) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toBe("You are a specialized coding assistant.");
  });

  it("combines prependContext from multiple concurrent experiments", async () => {
    const multiExpConfig: PromptAbTestConfig = {
      experiments: [
        {
          id: "tone-test",
          variants: [
            {
              id: "formal",
              weight: 1,
              // Force this variant by using weight=1 with control weight=0
              prependContext: "Use formal language.",
            },
            { id: "control", weight: 0 },
          ],
        },
        {
          id: "brevity-test",
          variants: [
            { id: "control", weight: 0 },
            { id: "brief", weight: 1, prependContext: "Keep replies under 3 sentences." },
          ],
        },
      ],
    };
    const { api, hooks } = makeApi(multiExpConfig);
    register(api as never);

    const result = (await hooks.before_prompt_build(
      { prompt: "hello", messages: [] },
      { sessionKey: "multi-exp-sess", agentId: "agent-1" },
    )) as { prependContext?: string } | undefined;

    expect(result?.prependContext).toContain("Use formal language.");
    expect(result?.prependContext).toContain("Keep replies under 3 sentences.");
  });

  it("skips experiment when agentId does not match agentIds filter", async () => {
    const filteredConfig: PromptAbTestConfig = {
      experiments: [
        {
          id: "agent-filtered",
          agentIds: ["allowed-agent"],
          variants: [{ id: "control", weight: 0 }, { id: "active", weight: 1, prependContext: "INJECTED" }],
        },
      ],
    };
    const { api, hooks } = makeApi(filteredConfig);
    register(api as never);

    // Different agent: experiment should be skipped → undefined.
    const result = await hooks.before_prompt_build(
      { prompt: "hi", messages: [] },
      { sessionKey: "sess-1", agentId: "blocked-agent" },
    );
    expect(result).toBeUndefined();
  });

  it("applies experiment when agentId matches agentIds filter", async () => {
    const filteredConfig: PromptAbTestConfig = {
      experiments: [
        {
          id: "agent-filtered",
          agentIds: ["allowed-agent"],
          variants: [{ id: "control", weight: 0 }, { id: "active", weight: 1, prependContext: "INJECTED" }],
        },
      ],
    };
    const { api, hooks } = makeApi(filteredConfig);
    register(api as never);

    const result = (await hooks.before_prompt_build(
      { prompt: "hi", messages: [] },
      { sessionKey: "sess-1", agentId: "allowed-agent" },
    )) as { prependContext?: string } | undefined;

    expect(result?.prependContext).toBe("INJECTED");
  });

  it("falls back to sessionId when sessionKey is absent", async () => {
    const { api, hooks } = makeApi(twoVariantConfig);
    register(api as never);

    // Should not throw even with no sessionKey.
    await expect(
      hooks.before_prompt_build({ prompt: "hi", messages: [] }, { sessionId: "fallback-id" }),
    ).resolves.not.toThrow();
  });
});

describe("agent_end hook", () => {
  it("logs variant assignments after a run", async () => {
    const config: PromptAbTestConfig = {
      experiments: [
        {
          id: "exp-log",
          variants: [
            { id: "control", weight: 0 },
            { id: "variant-a", weight: 1, prependContext: "Test." },
          ],
        },
      ],
    };
    const { api, hooks } = makeApi(config);
    register(api as never);

    // Trigger prompt build to populate the cache.
    await hooks.before_prompt_build(
      { prompt: "hello", messages: [] },
      { sessionKey: "log-sess" },
    );

    await hooks.agent_end({ messages: [], success: true }, { sessionKey: "log-sess" });

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/assignments.*log-sess.*exp-log=variant-a/),
    );
  });

  it("does not log when sessionKey is absent", async () => {
    const config: PromptAbTestConfig = {
      experiments: [
        { id: "exp-nolog", variants: [{ id: "control" }] },
      ],
    };
    const { api, hooks } = makeApi(config);
    register(api as never);

    const callsBefore = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;
    await hooks.agent_end({ messages: [], success: true }, {});
    const callsAfter = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.length;

    // No new info calls with "assignments" keyword.
    const assignmentLogs = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls
      .slice(callsBefore)
      .filter(([msg]) => String(msg).includes("assignments"));
    expect(assignmentLogs).toHaveLength(0);
  });
});

describe("gateway_start hook", () => {
  it("logs each active experiment summary", async () => {
    const config: PromptAbTestConfig = {
      experiments: [
        {
          id: "exp-summary",
          description: "Testing tone",
          variants: [
            { id: "control", weight: 1 },
            { id: "variant-a", weight: 2 },
          ],
        },
      ],
    };
    const { api, hooks } = makeApi(config);
    register(api as never);

    await hooks.gateway_start({ port: 3000 }, { port: 3000 });

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/exp-summary.*Testing tone.*control.*variant-a/),
    );
  });
});
