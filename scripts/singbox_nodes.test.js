#!/usr/bin/env bun
// 节点解析与分组生成的单元测试。
//
// 通过 scripts/singbox_rules.py 的 outbounds 子命令驱动：只做解析与拼装，不联网、
// 不读任何真实订阅。节点地址、uuid、密码全部是编造的。
//
// 用法：bun test scripts/singbox_nodes.test.js

import { describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

const SCRIPT = "scripts/singbox_rules.py";
const MANIFEST = "config/rules/index.txt";
const TEMPLATE = "config/sing-box/conf.d/10-public.json";

/** 分流 tag 的真相是规则清单的 policy 列（与生成器同一条推导），测试不另抄一份。 */
async function manifestGroups() {
  const text = await Bun.file(MANIFEST).text();
  const policies = text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("|")[1].trim());
  return [...new Set(policies)].filter((policy) => policy !== "direct" && policy !== "reject");
}

/** 主分组 tag 的真相是公开层的 route.final。 */
async function mainGroup() {
  return JSON.parse(await Bun.file(TEMPLATE).text()).route.final;
}

const UUID = "11111111-2222-3333-4444-555555555555";

const LINKS = {
  vless: `vless://${UUID}@example.com:443?encryption=none&security=tls&sni=cdn.example.com&type=ws&host=cdn.example.com&path=%2Fws%3Fed%3D2048&fp=chrome#vless-node`,
  trojan: "trojan://p%40ss@example.org:443?sni=example.org&type=grpc&serviceName=svc#trojan-node",
  ss: "ss://YWVzLTI1Ni1nY206cGFzcw@example.org:8388#ss-node",
  hy2: "hysteria2://pass@example.org:8443?sni=example.org&insecure=1&obfs=salamander&obfs-password=obfsp#hy2-node",
  tuic: `tuic://${UUID}:pass@example.org:8443?congestion_control=bbr&alpn=h3&sni=example.org#tuic-node`,
  anytls: "anytls://pass@example.org:8443?sni=example.org&insecure=1#anytls-node",
};

const VMESS_JSON = {
  v: "2",
  ps: "vmess-node",
  add: "example.net",
  port: "8443",
  id: UUID,
  aid: "0",
  scy: "auto",
  net: "ws",
  host: "cdn.example.net",
  path: "/vm",
  tls: "tls",
  sni: "cdn.example.net",
};
const VMESS = `vmess://${Buffer.from(JSON.stringify(VMESS_JSON)).toString("base64")}`;

const ALL_LINKS = [LINKS.vless, VMESS, LINKS.ss, LINKS.trojan, LINKS.hy2, LINKS.tuic, LINKS.anytls];

/** 跑一次 outbounds，返回 { stdout, stderr, exitCode }。 */
function run(payload) {
  const proc = Bun.spawnSync(
    ["uv", "run", "python", "-B", SCRIPT, "outbounds", "--input", "-"],
    { stdin: Buffer.from(JSON.stringify(payload)) },
  );
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

/** 取产出里的 outbounds 数组，按 tag 建索引。 */
function outboundsByTag(payload) {
  const { stdout, stderr, exitCode } = run(payload);
  expect(exitCode, stderr).toBe(0);
  return new Map(JSON.parse(stdout).outbounds.map((item) => [item.tag, item]));
}

function groupsOf(all) {
  return [...all.values()].filter((item) => item.type === "selector");
}

describe("outbounds -- 协议解析", () => {
  test("七种分享链接各自转成对应出站", () => {
    const nodes = outboundsByTag({ nodes: ALL_LINKS });

    expect(nodes.get("vless-node")).toMatchObject({
      type: "vless",
      server: "example.com",
      server_port: 443,
      uuid: UUID,
    });
    expect(nodes.get("vless-node").tls).toEqual({
      enabled: true,
      server_name: "cdn.example.com",
      utls: { enabled: true, fingerprint: "chrome" },
    });
    // `?ed=2048` 是早期数据，内核要的是独立字段，不能留在 path 里。
    expect(nodes.get("vless-node").transport).toEqual({
      type: "ws",
      path: "/ws",
      headers: { Host: "cdn.example.com" },
      max_early_data: 2048,
      early_data_header_name: "Sec-WebSocket-Protocol",
    });

    expect(nodes.get("vmess-node")).toMatchObject({
      type: "vmess",
      server: "example.net",
      server_port: 8443,
      uuid: UUID,
      security: "auto",
      alter_id: 0,
    });
    expect(nodes.get("vmess-node").transport).toEqual({
      type: "ws",
      path: "/vm",
      headers: { Host: "cdn.example.net" },
    });

    expect(nodes.get("ss-node")).toMatchObject({
      type: "shadowsocks",
      server: "example.org",
      server_port: 8388,
      method: "aes-256-gcm",
      password: "pass",
    });

    expect(nodes.get("trojan-node")).toMatchObject({
      type: "trojan",
      server: "example.org",
      password: "p@ss",
    });
    expect(nodes.get("trojan-node").transport).toEqual({ type: "grpc", service_name: "svc" });
    expect(nodes.get("trojan-node").tls).toEqual({ enabled: true, server_name: "example.org" });

    expect(nodes.get("hy2-node")).toMatchObject({
      type: "hysteria2",
      server: "example.org",
      server_port: 8443,
      password: "pass",
      obfs: { type: "salamander", password: "obfsp" },
    });
    expect(nodes.get("hy2-node").tls).toEqual({
      enabled: true,
      server_name: "example.org",
      insecure: true,
    });

    expect(nodes.get("tuic-node")).toMatchObject({
      type: "tuic",
      uuid: UUID,
      password: "pass",
      congestion_control: "bbr",
    });
    expect(nodes.get("tuic-node").tls).toEqual({
      enabled: true,
      server_name: "example.org",
      alpn: ["h3"],
    });

    expect(nodes.get("anytls-node")).toMatchObject({
      type: "anytls",
      password: "pass",
      tls: { enabled: true, server_name: "example.org", insecure: true },
    });
  });

  test("hysteria2 省略端口时按官方 scheme 取 443", () => {
    const nodes = outboundsByTag({ nodes: ["hysteria2://pass@example.org#hy2-default"] });
    expect(nodes.get("hy2-default").server_port).toBe(443);
  });

  test("REALITY 链接按公钥生成 reality 段", () => {
    const link = `vless://${UUID}@example.com:443?security=reality&sni=www.example.com&pbk=PUBKEY&sid=abcd&fp=chrome#reality-node`;
    const nodes = outboundsByTag({ nodes: [link] });
    expect(nodes.get("reality-node").tls).toEqual({
      enabled: true,
      server_name: "www.example.com",
      utls: { enabled: true, fingerprint: "chrome" },
      reality: { enabled: true, public_key: "PUBKEY", short_id: "abcd" },
    });
  });

  test("tuic 缺 alpn 时补 h3，链接里给了就用链接的", () => {
    const plain = outboundsByTag({
      nodes: [`tuic://${UUID}:pass@example.org:8443?sni=example.org#tuic-plain`],
    });
    expect(plain.get("tuic-plain").tls).toEqual({
      enabled: true,
      server_name: "example.org",
      alpn: ["h3"],
    });

    const given = outboundsByTag({
      nodes: [`tuic://${UUID}:pass@example.org:8443?alpn=h3,h2#tuic-alpn`],
    });
    expect(given.get("tuic-alpn").tls.alpn).toEqual(["h3", "h2"]);
  });

  test("ss 的旧式整段编码同样能解析", () => {
    const legacy = `ss://${Buffer.from("aes-128-gcm:pw@example.org:8388").toString("base64")}#ss-legacy`;
    const nodes = outboundsByTag({ nodes: [legacy] });
    expect(nodes.get("ss-legacy")).toMatchObject({
      type: "shadowsocks",
      server: "example.org",
      server_port: 8388,
      method: "aes-128-gcm",
      password: "pw",
    });
  });
});

describe("outbounds -- 订阅与直连节点", () => {
  test("订阅解包出的节点与 node 参数产出一致", () => {
    const links = [LINKS.vless, LINKS.tuic];
    const direct = [...outboundsByTag({ nodes: links }).values()];
    const encoded = Buffer.from(links.join("\n")).toString("base64");
    expect([...outboundsByTag({ subscription: encoded }).values()]).toEqual(direct);
    // 明文订阅（部分机场直接回文本）走同一条路。
    expect([...outboundsByTag({ subscription: links.join("\n") }).values()]).toEqual(direct);
  });

  test("订阅与 node 参数同时给出时都收下", () => {
    const encoded = Buffer.from(LINKS.anytls).toString("base64");
    const all = outboundsByTag({ subscription: encoded, nodes: [LINKS.ss] });
    expect(all.has("anytls-node")).toBe(true);
    expect(all.has("ss-node")).toBe(true);
  });
});

describe("outbounds -- 分组", () => {
  test("清单里的分流 tag 全在，成员与默认值都指向存在的出站", async () => {
    const expected = await manifestGroups();
    const main = await mainGroup();
    const all = outboundsByTag({ nodes: [LINKS.vless, LINKS.trojan] });
    const groups = groupsOf(all);
    expect(groups.map((item) => item.tag).sort()).toEqual([...expected].sort());

    const tags = new Set(all.keys());
    expect(tags.size).toBe(all.size);
    for (const group of groups) {
      expect(group.type).toBe("selector");
      for (const member of group.outbounds) {
        expect(tags.has(member), `${group.tag} -> ${member}`).toBe(true);
      }
      expect(tags.has(group.default), `${group.tag} default`).toBe(true);
    }
    // 站点分组默认跟随主分组，于是换节点时只有主分组需要动。
    expect(all.get(main).outbounds).toEqual(["vless-node", "trojan-node"]);
    for (const tag of expected.filter((item) => item !== main)) {
      expect(all.get(tag)).toMatchObject({ default: main });
    }
  });
});

describe("outbounds -- 坏输入", () => {
  test("畸形节点被跳过，其余节点照常产出", async () => {
    const { stdout, stderr, exitCode } = run({
      nodes: [LINKS.vless, "vless://", "ssr://bogus", "#comment", LINKS.trojan],
    });
    expect(exitCode, stderr).toBe(0);
    const outbounds = JSON.parse(stdout).outbounds;
    const tags = outbounds.map((item) => item.tag);
    expect(tags).toContain("vless-node");
    expect(tags).toContain("trojan-node");
    expect(outbounds.filter((item) => item.type === "selector")).toHaveLength(
      (await manifestGroups()).length,
    );
    expect(stderr).toContain("跳过第 2 个节点");
    expect(stderr).toContain("跳过第 3 个节点");
  });

  test("认不出的可选参数只提示，不丢节点", () => {
    const { stdout, stderr, exitCode } = run({
      nodes: [
        `tuic://${UUID}:pass@example.org:8443?congestion_control=reno&udp_relay_mode=quik#tuic-odd`,
        `vless://${UUID}@example.com:443?security=tls&flow=xtls-rprx-direct&packetEncoding=bogus#vless-odd`,
      ],
    });
    expect(exitCode, stderr).toBe(0);
    const nodes = new Map(JSON.parse(stdout).outbounds.map((item) => [item.tag, item]));
    expect(nodes.get("tuic-odd")).toMatchObject({ type: "tuic", password: "pass" });
    expect(nodes.get("tuic-odd").congestion_control).toBeUndefined();
    expect(nodes.get("tuic-odd").udp_relay_mode).toBeUndefined();
    expect(nodes.get("vless-odd").flow).toBeUndefined();
    expect(nodes.get("vless-odd").packet_encoding).toBeUndefined();
    expect(stderr).toContain("忽略未知的拥塞控制");
    expect(stderr).toContain("忽略未知的 flow");
  });

  test("节点重名、无名或与分流 tag 撞名时仍各自唯一", async () => {
    const main = await mainGroup();
    const all = outboundsByTag({
      nodes: [
        LINKS.vless,
        LINKS.vless,
        `vless://x@example.com:443#${main}`,
        "vless://x@example.com:443",
      ],
    });
    const tags = [...all.keys()];
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("vless-node-2");
    expect(tags).toContain(`${main}-2`);
    expect(tags).toContain("node-4");
  });

  test("没有可用节点时明确失败，不产出半成品", () => {
    for (const payload of [{}, { nodes: ["ssr://bogus", "not-a-link"] }]) {
      const { stdout, stderr, exitCode } = run(payload);
      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("没有可用节点");
    }
  });

  test("订阅里挑不出链接时如实上报", () => {
    const { stderr, exitCode } = run({
      subscription: Buffer.from("here is nothing useful").toString("base64"),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("订阅里没有可识别的节点链接");
  });
});

describe("outbounds -- 结构校验", () => {
  test("产出能通过 sing-box 的 check", async () => {
    const { stdout, stderr, exitCode } = run({ nodes: ALL_LINKS });
    expect(exitCode, stderr).toBe(0);
    const config = {
      log: { level: "warn" },
      outbounds: JSON.parse(stdout).outbounds,
      route: { final: "proxy" },
    };

    const path = `${tmpdir()}/singbox-nodes-check.json`;
    await Bun.write(path, JSON.stringify(config));
    try {
      const check = Bun.spawnSync(["sing-box", "check", "-c", path]);
      expect(check.exitCode, check.stderr.toString()).toBe(0);
    } finally {
      await unlink(path);
    }
  });
});
