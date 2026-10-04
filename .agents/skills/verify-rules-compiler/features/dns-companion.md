# DNS 伴生产物

底模 DNS 规则只能按查询名判定，所以每个被 DNS 规则引用的清单产物都要有一份「只含域名条目」的 `-dns` 副本。用户看到的是 `generated/singbox/<tag>-dns.srs` 的存在与内容符合规则。

## Sub-features

- `dns-internal`：内部 YAML 经 `emitSingboxDns` 过滤出域名字段，产出域名版规则集。
- `dns-logical`：叶子全为域名字段的 `logical` 子树保留；含 IP / 端口等非域名字段的混合树整体丢弃。
- `dns-geosite`：外部 `geosite:` 上游本就只含域名条目，`-dns` 直接复用同一份 `.srs`。
- `dns-geoip-skip`：外部 `geoip:` 是 IP 集合，在 DNS 阶段无法判定，不产出 `-dns`。

## How to get to it (user POV)

- 被底模 `dns.rules` 引用的 tag 会自动获得伴生：看 `config/sing-box/modules/10-dns.json` 的 `rule_set` 列表。
- 产物：`generated/singbox/<tag>-dns.srs`（与同名 `.srs` 对应）。
- 发布：`https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox/<tag>-dns.srs`。

## Driving it with verify.js

Preconditions: 已 `launch`。

- 内部域名版复用逻辑：比对 `Adult-dns.srs` 与 `Adult.srs` 的 SHA-256（geosite 语义下二者相同）。
- geoip 不产伴生：`curl -s -o /dev/null -w '%{http_code}' https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox/geoip-cn-dns.srs` 应为 `404`。
- 域名版内容：`limactl shell --workdir /work proxy-test sh -c '/opt/proxy-test/bin/sing-box rule-set decompile /host-home/Code/active/proxy/config/rules/generated/singbox/<tag>-dns.srs -o /tmp/d.json && cat /tmp/d.json'`，断言只含 domain 类字段与纯域名逻辑树。

## Gotchas

- `decompile` 默认写文件，不加 `-o` 看不到 stdout。
- `geoip` 无 `-dns` 是设计而非缺陷；把它当缺失会误报。
- 空规则集（`rules: []`）是合法产物，内核接受，不视为构建失败。
- 单 tag 构建不清理目录，上一次的 `-dns` 残留可能让「不该存在」的断言误判；以整目录重跑为准。
