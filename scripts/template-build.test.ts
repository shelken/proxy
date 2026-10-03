import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assembleTemplate } from "./template-build.ts";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATE_PATH = join(ROOT, "config/sing-box/template.json");
describe("template-build assembler", () => {
  test("assembles modules into bit-for-bit identical template.json", () => {
    const expected = readFileSync(TEMPLATE_PATH, "utf-8");
    const assembled = assembleTemplate();
    expect(assembled).toBe(expected);
  });

  test("preserves non-whitelisted valid sing-box fields in dns, route, and top-level", () => {
    const tmpDir = `/tmp/test-modules-preserve-${Date.now()}`;
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "00-base.json"),
        JSON.stringify({
          log: { level: "warn" },
          dns: { cache_capacity: 4096, strategy: "prefer_ipv4" },
          route: { find_process: true, final: "proxy" }
        })
      );
      const assembled = JSON.parse(assembleTemplate(tmpDir));
      expect(assembled.log?.level).toBe("warn");
      expect(assembled.dns?.cache_capacity).toBe(4096);
      expect(assembled.route?.find_process).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("allows overriding scalar properties with empty string (final: \"\")", () => {
    const tmpDir = `/tmp/test-modules-override-${Date.now()}`;
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        join(tmpDir, "10-base.json"),
        JSON.stringify({
          route: { final: "proxy" },
          dns: { final: "dns-proxy" }
        })
      );
      writeFileSync(
        join(tmpDir, "20-override.json"),
        JSON.stringify({
          route: { final: "" },
          dns: { final: "" }
        })
      );
      const assembled = JSON.parse(assembleTemplate(tmpDir));
      expect(assembled.route?.final).toBe("");
      expect(assembled.dns?.final).toBe("");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
