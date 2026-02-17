import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Config types
// ============================================================================

/**
 * A single variant within an experiment. Include a "control" variant with no
 * overrides to maintain a holdout group that sees the default built-in prompt.
 */
export type PromptVariant = {
  /** Unique variant identifier (e.g. "control", "variant-a"). */
  id: string;
  /**
   * Relative selection weight. Default: 1.
   * Example: weight=2 means twice as likely to be selected as weight=1.
   * Set to 0 to disable a variant without removing it.
   */
  weight?: number;
  /**
   * Text injected before the system prompt context sections for this variant.
   * Use this for surgical changes: override the identity line, adjust tone,
   * test different safety wording, or add extra behavioral instructions.
   *
   * Because the LLM treats later/more-specific instructions as higher priority,
   * this context can effectively shadow or extend any hardcoded prompt section.
   *
   * Example (testing a different assistant identity):
   *   "You are Alex, a concise technical assistant. Prioritize brevity."
   */
  prependContext?: string;
  /**
   * Full system prompt replacement for this variant. Overrides the entire
   * built-in prompt produced by buildAgentSystemPrompt().
   *
   * Use prependContext for targeted changes. Reserve systemPrompt for cases
   * where you need to test a completely different prompt structure.
   */
  systemPrompt?: string;
};

/** A single A/B test experiment. Multiple experiments can run in parallel. */
export type AbTestExperiment = {
  /** Unique experiment identifier (e.g. "identity-tone-v1"). */
  id: string;
  /** Human-readable description of what this experiment tests. */
  description?: string;
  /** Set to false to pause the experiment. Default: true. */
  enabled?: boolean;
  /** Variant pool. Must have at least one entry. */
  variants: PromptVariant[];
  /**
   * Restrict this experiment to specific agent IDs.
   * If omitted (or empty), the experiment applies to all agents.
   */
  agentIds?: string[];
};

export type PromptAbTestConfig = {
  /** List of A/B test experiments to run. */
  experiments?: AbTestExperiment[];
};

// ============================================================================
// Variant selection helpers (exported for testing)
// ============================================================================

/**
 * Deterministic djb2-based string hash.
 * Returns a stable unsigned 32-bit integer for any given input.
 */
export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    // ((hash << 5) + hash) ^ charCode  →  djb2 xor variant
    hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Select a variant from a weighted pool using a pre-computed numeric seed.
 * The same seed always produces the same variant (deterministic).
 *
 * Selection works by mapping the seed into [0, totalWeight) and walking the
 * cumulative weight distribution.
 */
export function selectVariant(variants: PromptVariant[], seed: number): PromptVariant {
  if (variants.length === 0) {
    throw new Error("selectVariant: variants array must not be empty");
  }

  const weights = variants.map((v) => Math.max(0, v.weight ?? 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // If all weights are zero, fall back to first variant.
  if (totalWeight <= 0) {
    return variants[0];
  }

  // Map seed to a fractional position in [0, totalWeight).
  // Use modulo 1_000_000 to create a fine-grained bucket while keeping the
  // operation fast and avoiding floating-point precision issues.
  const position = ((seed % 1_000_000) / 1_000_000) * totalWeight;

  let cumulative = 0;
  for (let i = 0; i < variants.length; i++) {
    cumulative += weights[i];
    if (position < cumulative) {
      return variants[i];
    }
  }

  // Floating-point edge case: return last variant.
  return variants[variants.length - 1];
}

/**
 * Assign a variant for a given session+experiment combination.
 * The assignment is deterministic: the same (sessionKey, experimentId) pair
 * always yields the same variant, ensuring session-level stability.
 */
export function assignVariant(
  sessionKey: string,
  experimentId: string,
  variants: PromptVariant[],
): PromptVariant {
  const seed = hashString(`${sessionKey}:${experimentId}`);
  return selectVariant(variants, seed);
}

// ============================================================================
// Plugin registration
// ============================================================================

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PromptAbTestConfig;

  // Validate and filter experiments.
  const experiments: AbTestExperiment[] = (cfg.experiments ?? []).filter(
    (exp): exp is AbTestExperiment => {
      if (!exp || typeof exp.id !== "string" || !exp.id.trim()) {
        api.logger.warn("prompt-ab-test: skipping experiment with missing id");
        return false;
      }
      if (!Array.isArray(exp.variants) || exp.variants.length === 0) {
        api.logger.warn(
          `prompt-ab-test: skipping experiment "${exp.id}" — must have at least one variant`,
        );
        return false;
      }
      return true;
    },
  );

  const activeExperiments = experiments.filter((exp) => exp.enabled !== false);

  if (activeExperiments.length === 0) {
    api.logger.info("prompt-ab-test: no active experiments configured, plugin is idle");
    return;
  }

  api.logger.info(
    `prompt-ab-test: loaded ${activeExperiments.length} active experiment(s): ${activeExperiments.map((e) => e.id).join(", ")}`,
  );

  // ---------------------------------------------------------------------------
  // Assignment cache: Map<`${sessionKey}:${experimentId}`, PromptVariant>
  //
  // Caching avoids re-hashing on every turn and ensures the same variant is
  // used even if the session key shifts slightly between turns in edge cases.
  // ---------------------------------------------------------------------------
  const assignmentCache = new Map<string, PromptVariant>();

  function getVariantForSession(sessionKey: string, experiment: AbTestExperiment): PromptVariant {
    const cacheKey = `${sessionKey}:${experiment.id}`;
    const cached = assignmentCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const variant = assignVariant(sessionKey, experiment.id, experiment.variants);
    assignmentCache.set(cacheKey, variant);
    api.logger.debug?.(
      `prompt-ab-test: assigned session=${sessionKey} experiment=${experiment.id} → variant=${variant.id}`,
    );
    return variant;
  }

  // ---------------------------------------------------------------------------
  // before_prompt_build: inject variant-specific prompt modifications.
  //
  // For each active experiment (filtered by agentId if configured):
  //  - Collect `prependContext` values from each assigned variant; they are
  //    joined and prepended to the system prompt context.
  //  - Collect `systemPrompt` overrides; the last experiment with one wins
  //    (experiments are processed in config order, so put higher-priority
  //    experiments later in the list).
  //
  // Returning undefined (no active modifications) is safe: the built-in prompt
  // builder runs unchanged, which is correct for "control" variants.
  // ---------------------------------------------------------------------------
  api.on("before_prompt_build", async (_event, ctx) => {
    const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? "anonymous";
    const agentId = ctx.agentId;

    let resultSystemPrompt: string | undefined;
    const prependParts: string[] = [];

    for (const experiment of activeExperiments) {
      // Honour agentIds filter if specified.
      if (
        Array.isArray(experiment.agentIds) &&
        experiment.agentIds.length > 0 &&
        (!agentId || !experiment.agentIds.includes(agentId))
      ) {
        continue;
      }

      const variant = getVariantForSession(sessionKey, experiment);

      if (variant.systemPrompt) {
        resultSystemPrompt = variant.systemPrompt;
      }

      if (variant.prependContext?.trim()) {
        prependParts.push(variant.prependContext.trim());
      }
    }

    // Return undefined when no experiment produced any modification (e.g. all
    // assigned variants are pure control variants).
    if (resultSystemPrompt === undefined && prependParts.length === 0) {
      return undefined;
    }

    return {
      ...(resultSystemPrompt !== undefined ? { systemPrompt: resultSystemPrompt } : {}),
      ...(prependParts.length > 0 ? { prependContext: prependParts.join("\n\n") } : {}),
    };
  });

  // ---------------------------------------------------------------------------
  // agent_end: emit structured variant assignment log for analytics pipelines.
  //
  // Log lines are formatted as:
  //   prompt-ab-test: assignments session=<key> [exp1=variant-id, exp2=variant-id]
  //
  // These can be parsed by log aggregators (e.g. Loki, Datadog) to measure
  // outcome differences between variants.
  // ---------------------------------------------------------------------------
  api.on("agent_end", async (_event, ctx) => {
    const sessionKey = ctx.sessionKey ?? ctx.sessionId;
    if (!sessionKey) return;

    const assignments = activeExperiments
      .map((exp) => {
        const cacheKey = `${sessionKey}:${exp.id}`;
        const variant = assignmentCache.get(cacheKey);
        return variant ? `${exp.id}=${variant.id}` : null;
      })
      .filter((entry): entry is string => entry !== null);

    if (assignments.length > 0) {
      api.logger.info(
        `prompt-ab-test: assignments session=${sessionKey} [${assignments.join(", ")}]`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // gateway_start: emit experiment summary so operators can verify config.
  // ---------------------------------------------------------------------------
  api.on("gateway_start", async () => {
    for (const exp of activeExperiments) {
      const variantSummary = exp.variants
        .map((v) => `${v.id}(w=${v.weight ?? 1})`)
        .join(", ");
      api.logger.info(
        `prompt-ab-test: experiment "${exp.id}" — ${exp.description ?? "no description"} — variants: [${variantSummary}]`,
      );
    }
  });
}
