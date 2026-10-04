# 外部规则镜像

把 `geosite:x` / `geoip:x` 形式的清单项直接镜像成 MetaCubeX/meta-rules-dat 的三端原生资产，本地不做任何语法转译。用户看到的是构建后 `generated/` 下与上游一致的三端产物，以及发布分支上可通过 URL 直接引用的同一份内容。

## Sub-features

- `ext-path`：`geosite:x` → `sing/geo/geosite/x.srs` + `meta/geo/geosite/x.yaml` + `meta/geo/geosite/x.list`。
- `ext-ip`：`geoip:x` → 对应 `geoip` 目录的三端资产。
- `ext-identity`：产物字节与上游完全一致（镜像，非重编译）。
- `ext-publish`：发布分支 `sing-box-rules` 下的路径与清单 tag 对应。

## How to get to it (user POV)

- 清单里写 `TagName: geosite:telegram` 或 `TagName: geoip:cn`（`config/rules/index.yaml`）。
- 构建：`just rules-build` 或 `just rules-build-one <tag>`。
- 消费：`template.json` 的 `route.rule_set` 以 `https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox/<tag>.srs` 引用。
- 直接下载：浏览器/`curl` 打开上述 URL。

## Driving it with verify.js

Preconditions: 已 `launch`，`generated/` 来自本次构建。

- 看镜像产物存在且非空：`D1/singbox/geoip-cn`（`.srs`）、`D1/clash/geoip-cn`（`.yaml`）、`D1/plain/geoip-cn`（`.list`）。
- 看镜像内容规模：`D2/geoip-cn` 断言反编译后只有一条 `ip_cidr` 规则且 CIDR 数 > 1000。
- 看发布可达：`curl -s -o /dev/null -w '%{http_code}' https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/singbox/geoip-cn.srs` 返回 `200`。
- 看字节一致（本地 == 发布）：对同一 tag 分别取本地 `generated/singbox/<tag>.srs` 与发布 URL 的 SHA-256，应相等。

## Gotchas

- `raw.githubusercontent.com` 有约 5 分钟缓存；刚发布后立即比对可能拿到上一版，先看 CI run 完成时间再比对。
- `.list` 是 `+.domain.com` 通配形态（mihomo text / DOMAIN-SET 兼容），不是 Loon RULE-SET 的 `TYPE,VALUE`；不要按 RULE-SET 解析它。
- `geoip` 的 `.list` 是裸 CIDR 行，同样不是 RULE-SET。
- 单 tag 构建不清空 `generated/`，可能留下旧文件；判定产物必须来自本次 launch。
