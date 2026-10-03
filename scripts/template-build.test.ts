import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
});
