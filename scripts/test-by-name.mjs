#!/usr/bin/env bun
// 按关键字查找并运行匹配的 *.test.js
// 用法: bun run scripts/test-by-name.mjs <关键字>
// 内部被 just run-test 调用，也可直接使用

import { execSync } from "node:child_process";

const name = process.argv[2];
if (!name) {
  console.error("用法: bun run scripts/test-by-name.mjs <关键字>");
  process.exit(1);
}

const files = execSync(
  `find . -name "*.test.js" -not -path "./.git/*" -not -path "./node_modules/*"`
)
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

const matched = files.filter((f) => f.toLowerCase().includes(name.toLowerCase()));
if (matched.length === 0) {
  console.error(`未找到匹配 '${name}' 的测试文件`);
  process.exit(1);
}

execSync(`bun test --test-specifier ${matched.join(" ")}`, {
  stdio: "inherit",
});
