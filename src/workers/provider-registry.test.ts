import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  listProviders,
  resolveProvider,
  type ProviderConfig,
} from "./provider-registry.js";

/**
 * Phase 9 / 09-01 Task 1 — provider registry behaviors (DISPATCH-01, DISPATCH-02).
 *
 * Every test passes an INJECTED env object — process.env is never mutated.
 */

const BUILTIN_NAMES = [
  "codex",
  "openrouter",
  "lmstudio",
  "lmstudio-agentic",
  "anthropic",
] as const;

/** Fresh injected env — never process.env. */
function env(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...vars };
}

type RelayErrorish = Error & { code?: string };

describe("provider-registry — listProviders", () => {
  test("Test 1: no RELAY_PROVIDER_* env → exactly the five builtins, source 'builtin'", () => {
    const list = listProviders(env());
    assert.deepStrictEqual(
      list.map((p) => p.name).sort(),
      [...BUILTIN_NAMES].sort()
    );
    for (const p of list) {
      assert.strictEqual(p.source, "builtin", `${p.name} must be builtin`);
    }
  });

  test("Test 1b: builtins carry today's env-var names (behavior parity, DISPATCH-02)", () => {
    const byName = new Map(listProviders(env()).map((p) => [p.name, p]));
    assert.strictEqual(byName.get("openrouter")!.keyEnvVar, "OPENROUTER_API_KEY");
    assert.strictEqual(byName.get("lmstudio")!.keyEnvVar, "LMSTUDIO_API_KEY");
    assert.strictEqual(byName.get("lmstudio-agentic")!.keyEnvVar, "LMSTUDIO_API_KEY");
    assert.strictEqual(byName.get("anthropic")!.keyEnvVar, "ANTHROPIC_API_KEY");
    assert.strictEqual(byName.get("codex")!.keyEnvVar, null);
    assert.strictEqual(byName.get("codex")!.url, null);
    assert.strictEqual(byName.get("anthropic")!.type, "anthropic");
  });

  test("Test 2: RELAY_PROVIDER_GROQ_URL + _KEY → 'groq' entry, source 'env', default type 'openai'", () => {
    const e = env({
      RELAY_PROVIDER_GROQ_URL: "https://api.groq.com/openai/v1",
      RELAY_PROVIDER_GROQ_KEY: "synthetic-groq-key-do-not-print",
    });
    const groq = listProviders(e).find((p) => p.name === "groq");
    assert.ok(groq, "groq must be discovered");
    assert.strictEqual(groq.source, "env");
    assert.strictEqual(groq.type, "openai");
  });
});

describe("provider-registry — resolveProvider (env discovery)", () => {
  test("Test 2b: resolved groq carries URL, key ENV VAR NAME (never the value), empty headers", () => {
    const e = env({
      RELAY_PROVIDER_GROQ_URL: "https://api.groq.com/openai/v1",
      RELAY_PROVIDER_GROQ_KEY: "synthetic-groq-key-do-not-print",
    });
    const groq: ProviderConfig = resolveProvider("groq", e);
    assert.strictEqual(groq.url, "https://api.groq.com/openai/v1/chat/completions");
    assert.strictEqual(groq.keyEnvVar, "RELAY_PROVIDER_GROQ_KEY");
    assert.deepStrictEqual(groq.headers, {});
    // Config must stay printable without leaking secrets.
    assert.ok(
      !JSON.stringify(groq).includes("synthetic-groq-key-do-not-print"),
      "ProviderConfig must never carry a key VALUE"
    );
  });

  test("Test 3: RELAY_PROVIDER_MYCLAUDE_TYPE=anthropic → type 'anthropic'", () => {
    const e = env({
      RELAY_PROVIDER_MYCLAUDE_URL: "https://my-claude-proxy.example/v1",
      RELAY_PROVIDER_MYCLAUDE_TYPE: "anthropic",
    });
    assert.strictEqual(resolveProvider("myclaude", e).type, "anthropic");
  });

  test("Test 3b: invalid _TYPE is a RelayError naming the allowed values", () => {
    const e = env({
      RELAY_PROVIDER_BAD_URL: "https://bad.example",
      RELAY_PROVIDER_BAD_TYPE: "grpc",
    });
    assert.throws(
      () => resolveProvider("bad", e),
      (err: RelayErrorish) => {
        assert.strictEqual(err.code, "CONFIG_ERROR");
        assert.match(err.message, /openai/);
        assert.match(err.message, /anthropic/);
        return true;
      }
    );
  });

  test("Test 4: _HEADER_X_API_VERSION surfaces as 'x-api-version' (lowercased, _ → -)", () => {
    const e = env({
      RELAY_PROVIDER_X_URL: "https://x.example/v1",
      RELAY_PROVIDER_X_HEADER_X_API_VERSION: "2026-01",
    });
    assert.deepStrictEqual(resolveProvider("x", e).headers, {
      "x-api-version": "2026-01",
    });
  });

  test("Test 5: unknown provider → RelayError listing available names (builtin + discovered)", () => {
    const e = env({
      RELAY_PROVIDER_GROQ_URL: "https://api.groq.com/openai/v1",
    });
    assert.throws(
      () => resolveProvider("nonexistent", e),
      (err: RelayErrorish) => {
        assert.strictEqual(err.code, "UNKNOWN_PROVIDER");
        for (const name of BUILTIN_NAMES) {
          assert.match(err.message, new RegExp(name));
        }
        assert.match(err.message, /groq/);
        return true;
      }
    );
  });

  test("Test 6: env definition colliding with a builtin name → RelayError at resolve (builtin wins, never silent)", () => {
    const e = env({
      RELAY_PROVIDER_LMSTUDIO_URL: "http://elsewhere.example:9999",
    });
    assert.throws(
      () => resolveProvider("lmstudio", e),
      (err: RelayErrorish) => {
        assert.strictEqual(err.code, "PROVIDER_NAME_CONFLICT");
        assert.match(err.message, /lmstudio/);
        return true;
      }
    );
    // The inventory still shows the builtin exactly once — no silent override.
    const entries = listProviders(e).filter((p) => p.name === "lmstudio");
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0]!.source, "builtin");
  });
});

describe("provider-registry — request URL suffixing (Test 7)", () => {
  test("openai-type URL without /chat/completions gets it appended", () => {
    const e = env({ RELAY_PROVIDER_A_URL: "http://host:1234/v1" });
    assert.strictEqual(
      resolveProvider("a", e).url,
      "http://host:1234/v1/chat/completions"
    );
  });

  test("openai-type URL already ending in /chat/completions is untouched", () => {
    const e = env({
      RELAY_PROVIDER_A_URL: "http://host:1234/v1/chat/completions",
    });
    assert.strictEqual(
      resolveProvider("a", e).url,
      "http://host:1234/v1/chat/completions"
    );
  });

  test("trailing slashes are trimmed before suffixing", () => {
    const e = env({ RELAY_PROVIDER_A_URL: "http://host:1234/v1///" });
    assert.strictEqual(
      resolveProvider("a", e).url,
      "http://host:1234/v1/chat/completions"
    );
  });

  test("anthropic-type bare host appends /v1/messages", () => {
    const e = env({
      RELAY_PROVIDER_B_URL: "https://api.example.com",
      RELAY_PROVIDER_B_TYPE: "anthropic",
    });
    assert.strictEqual(
      resolveProvider("b", e).url,
      "https://api.example.com/v1/messages"
    );
  });

  test("anthropic-type URL ending in /v1 appends only /messages", () => {
    const e = env({
      RELAY_PROVIDER_B_URL: "https://api.example.com/v1",
      RELAY_PROVIDER_B_TYPE: "anthropic",
    });
    assert.strictEqual(
      resolveProvider("b", e).url,
      "https://api.example.com/v1/messages"
    );
  });

  test("anthropic-type URL already ending in /messages is untouched", () => {
    const e = env({
      RELAY_PROVIDER_B_URL: "https://api.example.com/v1/messages",
      RELAY_PROVIDER_B_TYPE: "anthropic",
    });
    assert.strictEqual(
      resolveProvider("b", e).url,
      "https://api.example.com/v1/messages"
    );
  });
});
