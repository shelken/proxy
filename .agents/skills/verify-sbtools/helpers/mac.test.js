#!/usr/bin/env -S bun test
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const binary = process.env.SBTOOLS_BIN;
const root = mkdtempSync(join(tmpdir(), "sbtools-mac-"));
const env = { PATH: process.env.PATH, HOME: join(root, "home") };
mkdirSync(env.HOME, { recursive: true });
const records = [];
const processes = [];
let server;
let serverLog = "";

beforeAll(async () => {
  expect(process.platform).toBe("darwin");
  const keygen = Bun.spawnSync([binary, "keygen"], { env });
  expect(keygen.exitCode).toBe(0);
  const secret = keygen.stdout.toString().match(/^SERVER_PRIVATE_KEY=([a-f0-9]{64})$/m)?.[1];
  expect(typeof secret).toBe("string");
  records.push({ name: "mac-keygen", command: ["sbtools", "keygen"], exit: keygen.exitCode, privateKeyOmitted: true });
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reservation") });
  const port = reserve.port;
  reserve.stop(true);
  server = "http://127.0.0.1:" + port;
  const p = Bun.spawn([binary, "server", "--port", String(port)], { env: { ...env, SERVER_PRIVATE_KEY: secret }, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  void (async () => { for await (const chunk of p.stderr) serverLog += new TextDecoder().decode(chunk); })();
  // 就绪由独立 Rust 进程提供，虚拟时钟不能控制其监听端口。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (p.exitCode !== null) throw new Error(serverLog);
    try { if ((await fetch(server + "/healthz")).ok) return; } catch {}
    await Bun.sleep(40);
  }
  throw new Error("owned mac server not ready\n" + serverLog);
}, 10000);

afterAll(async () => {
  for (const p of processes) { if (p.exitCode === null) p.kill(); await p.exited; }
  await Bun.write("results-mac.json", JSON.stringify(records, null, 2));
  await Bun.write("server-mac.log", serverLog);
  rmSync(root, { recursive: true, force: true });
});

test("macOS version entry points run the new binary", () => {
  const outputs = ["version", "--version", "-V"].map(flag => {
    const p = Bun.spawnSync([binary, flag], { env });
    const stdout = p.stdout.toString();
    records.push({ name: "mac-" + flag, command: ["sbtools", flag], exit: p.exitCode, stdout, stderr: p.stderr.toString() });
    expect(p.exitCode).toBe(0); expect(stdout).toMatch(/^sbtools \d+\.\d+\.\d+\n$/);
    return stdout;
  });
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0]);
});

test("macOS encode writes the actual URL to the clipboard and restores every original type", async () => {
  const config = join(root, "client.yaml");
  writeFileSync(config, "nodes:\n  - hy2://synthetic-pass@192.0.2.1:443?sni=example.test#selfhost-hk\n");
  const script = join(root, "clipboard.js");
  writeFileSync(script, `ObjC.import('AppKit'); ObjC.import('Foundation');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = [];
  const items = pb.pasteboardItems;
  if (items) for (let i = 0; i < items.count; i++) {
    const original = items.objectAtIndex(i);
    const copy = $.NSPasteboardItem.alloc.init;
    const types = original.types;
    for (let j = 0; j < types.count; j++) {
      const type = types.objectAtIndex(j);
      copy.setDataForType(original.dataForType(type), type);
    }
    saved.push(copy);
  }
  let ours = false, count = 0, result;
  try {
    const task = $.NSTask.alloc.init;
    task.launchPath = argv[0];
    task.arguments = $(['encode', '-s', argv[1], '-c', argv[2]]);
    const output = $.NSPipe.pipe;
    const errors = $.NSPipe.pipe;
    task.standardOutput = output; task.standardError = errors;
    task.launch; task.waitUntilExit;
    const stdout = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(output.fileHandleForReading.readDataToEndOfFile, $.NSUTF8StringEncoding));
    const stderr = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(errors.fileHandleForReading.readDataToEndOfFile, $.NSUTF8StringEncoding));
    const url = stdout.split('\\n').find(line => line.startsWith(argv[1] + '/sub?d='));
    const pasted = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString));
    ours = Boolean(url) && pasted === url;
    count = pb.changeCount;
    if (task.terminationStatus !== 0 || !ours) throw new Error('encode did not put its URL on clipboard: ' + stderr);
    result = { exit: task.terminationStatus, stdout, stderr, clipboardMatched: true };
  } finally {
    if (ours && pb.changeCount === count) {
      pb.clearContents;
      if (saved.length && !pb.writeObjects($(saved))) throw new Error('clipboard restore failed');
      const restored = pb.pasteboardItems;
      if ((restored ? Number(restored.count) : 0) !== saved.length) throw new Error('clipboard item count differs after restore');
      for (let i = 0; i < saved.length; i++) {
        const types = saved[i].types;
        for (let j = 0; j < types.count; j++) {
          const type = types.objectAtIndex(j);
          if (!restored.objectAtIndex(i).dataForType(type).isEqualToData(saved[i].dataForType(type))) throw new Error('clipboard data differs after restore');
        }
      }
      if (result) result.clipboardRestored = true;
    } else if (result) throw new Error('another app changed clipboard; its new content was left intact');
  }
  return JSON.stringify(result);
}`);
  const p = Bun.spawn(["osascript", "-l", "JavaScript", script, binary, server, config], { env, stdout: "pipe", stderr: "pipe" });
  processes.push(p);
  const [stdout, stderr, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  records.push({ name: "mac-encode-clipboard", command: ["sbtools", "encode", "-s", server, "-c", "synthetic-client.yaml"], exit, stdout, stderr });
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.exit).toBe(0); expect(result.clipboardMatched).toBe(true); expect(result.clipboardRestored).toBe(true);
  expect(result.stdout).toContain("订阅 URL 已复制到剪切板");
}, 15000);
