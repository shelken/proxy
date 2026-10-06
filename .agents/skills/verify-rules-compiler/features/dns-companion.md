# DNS 伴生产物

底模 DNS 规则只能按查询名判定，所以要有一份「只含域名条目」的 `-dns` 副本。产出范围是**全部 internal 与 geosite tag**（与是否被底模引用无关），geoip 不产。用户看到的是 `config/rules/generated/singbox/<tag>-dns.srs` 的存在与内容符合规则，底模按 `10-dns.json` 引用其中四个。

## Sub-features

- `dns-internal`：内部 YAML 经 `emitSingboxDns` 过滤出域名字段，先发射 `<tag>-dns.json` 再编译成 `-dns.srs`。
- `dns-logical`：叶子全为域名字段的 `logical` 子树保留；含 IP / 端口等非域名字段的混合树整体丢弃（不影响同文件其它字段）。
- `dns-geosite`：外部 `geosite:` 上游本就只含域名条目，`-dns` 直接复用主产物的同一份字节（无中间 JSON）。
- `dns-geoip-skip`：外部 `geoip:` 是 IP 集合，在 DNS 阶段无法判定，不产出 `-dns`。

## How to get to it (user POV)

- 凡是 internal 或 geosite 的 tag 都会自动获得伴生；被底模实际消费的是 `config/sing-box/modules/10-dns.json` 引用的 `Lan-dns` / `MyDirect-dns` / `ChinaMax-dns` / `torrent-dns`。
- 产物：`config/rules/generated/singbox/<tag>-dns.srs`（internal 另有 `-dns.json` 中间产物）。
- 发布：`https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox/<tag>-dns.srs`。

## Driving it with verify.js

Preconditions: 已 `launch`。

- 产出与形态：`D4/internal`、`D4/internal-json`（internal 有 `-dns.json`）、`D4/geosite`、`D4/geosite-no-json`。
- 字节复用：`D4/geosite-reuse` 断言 `ChinaMax-dns.srs` 与 `ChinaMax.srs` 的 SHA-256 相同——用真正 geosite 的 ChinaMax，不能用 internal 的 Adult（那只是恰好纯域名）。
- 剔除验证：`D4/dns-only-fields` 断言 `Lan-dns` 反编译后只含 domain 类字段，`D4/filter-control` 作对照确认 `Lan` 主产物确含 `ip_cidr`。
- geoip 不产伴生：`D4/geoip-skip` 断言 `geoip-cn-dns.srs` 不存在；发布侧同 URL 应返回 `404`。

## Gotchas

- `decompile` 默认写文件，不加 `-o` 看不到 stdout。
- `geoip` 无 `-dns` 是设计而非缺陷；把它当缺失会误报。
- geosite 的伴生与主产物字节相同、**没有** `-dns.json`；internal 才有中间 JSON。断言形态时区分两类。
- 空规则集（`rules: []`）是合法产物，不视为构建失败。
- 单 tag 构建不清理目录，上一次的 `-dns` 残留可能让「不该存在」的断言误判；以整目录重跑为准。
