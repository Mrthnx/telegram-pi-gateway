import { describe, expect, test } from "bun:test";
import { parseModelSpec, resolveModelSpec } from "./model-spec";

describe("resolveModelSpec", () => {
  test("the gateway-owned override wins over the Pi harness variables", () => {
    const result = resolveModelSpec({ gatewayModel: "openai/gpt-5", piModel: "MiniMax-M3", piProvider: "minimax" });

    expect(result.spec).toBe("openai/gpt-5");
    expect(result.origin).toBe("gateway");
  });

  test("a Pi model that already carries its provider is kept untouched", () => {
    const result = resolveModelSpec({ piModel: "minimax/MiniMax-M3", piProvider: "minimax" });

    expect(result.spec).toBe("minimax/MiniMax-M3");
    expect(result.origin).toBe("pi-full");
  });

  test("a bare Pi model id is composed with PI_PROVIDER", () => {
    const result = resolveModelSpec({ piModel: "MiniMax-M3", piProvider: "minimax" });

    expect(result.spec).toBe("minimax/MiniMax-M3");
    expect(result.origin).toBe("pi-composed");
  });

  test("a bare Pi model id without a provider is ignored instead of breaking every prompt", () => {
    const result = resolveModelSpec({ piModel: "MiniMax-M3" });

    expect(result.spec).toBeUndefined();
    expect(result.origin).toBe("pi-unresolvable");
    expect(result.warning).toContain("PI_MODEL");
  });

  test("no model variable at all leaves the spec unset", () => {
    const result = resolveModelSpec({});

    expect(result.spec).toBeUndefined();
    expect(result.origin).toBe("unset");
    expect(result.warning).toBeUndefined();
  });

  test("a bare gateway model is kept verbatim so the strict error still surfaces", () => {
    const result = resolveModelSpec({ gatewayModel: "MiniMax-M3", piModel: "MiniMax-M3", piProvider: "minimax" });

    expect(result.spec).toBe("MiniMax-M3");
  });

  test("surrounding whitespace is ignored", () => {
    const result = resolveModelSpec({ piModel: "  MiniMax-M3  ", piProvider: " minimax " });

    expect(result.spec).toBe("minimax/MiniMax-M3");
  });
});

describe("parseModelSpec", () => {
  test("splits provider and model id", () => {
    expect(parseModelSpec("minimax/MiniMax-M3")).toEqual({ provider: "minimax", id: "MiniMax-M3" });
  });

  test("keeps slashes that belong to the model id", () => {
    expect(parseModelSpec("openrouter/vendor/model-v2")).toEqual({ provider: "openrouter", id: "vendor/model-v2" });
  });

  test("rejects a bare model id", () => {
    expect(() => parseModelSpec("MiniMax-M3")).toThrow(
      "Configured Pi model must be in provider/id format: MiniMax-M3",
    );
  });
});
