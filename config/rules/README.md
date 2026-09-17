# 规则目录

本目录是全部代理规则的唯一权威源。只在这里编辑规则，客户端产物由脚本生成。

## 结构

```
config/rules/
├── index.txt          # 规则清单（唯一需要手写的清单文件）
├── custom/            # 自有规则列表
└── generated/         # 生成产物，已 gitignore
```

## index.txt

三列，`|` 分隔：

```
tag|policy|source
```

- **tag** — 产物文件名，同时是 sing-box 里的 rule_set tag。
- **policy** — 路由策略，取值见下。
- **source** — 仓库相对路径读本地文件；以 `http` 开头则按 URL 拉取。

policy 与出站 tag 同名，`reject` 例外（编译成 `action: reject`）：

| policy | 用途 |
|---|---|
| `reject` | 拦截 |
| `direct` | 直连 |
| `proxy` | 代理 |
| `openai` / `gemini` / `appleai` / `dev` / `ptcg` / `japansite` / `adultnsfw` / `opencode` | 按服务分组的策略出站 |

`policy-order.txt` 决定路由优先级，先匹配先胜：一行一个 policy，顺序即优先级。没列进去的
policy 不会丢，只是按字母序排在已列出的之后（生成时会打印提示）。这份顺序是数据不是代码 ——
改顺序只改这个文件。

## custom/ 里的行格式

沿用 Surge / Loon 的行格式：

```
DOMAIN,example.com
DOMAIN-SUFFIX,example.com
DOMAIN-KEYWORD,example
DOMAIN-REGEX,^regex\..+
IP-CIDR,10.0.0.0/8,no-resolve
IP-CIDR6,2001:db8::/32
SRC-IP-CIDR,10.1.0.0/16
SRC-PORT,1234
DST-PORT,443
PROCESS-NAME,curl
GEOIP,cn
```

`#` 开头是注释，空行忽略。`.example.com` 是 `DOMAIN-SUFFIX,example.com` 的省略写法，裸域名是 `DOMAIN` 的省略写法，两种都支持。

## 生成产物

```
just build-rules
```

等价于 `uv run python -B scripts/singbox_rules.py build --all`。生成 `.srs` 需要 `sing-box` 在 PATH 里，
它由项目根的 `mise.toml` 固定；mise 未在当前 shell 激活时用 `mise exec -- just build-rules`。

产出按客户端分类到 `generated/`：

| 目录 | 格式 | 取用方 |
|---|---|---|
| `generated/singbox/` | `<tag>.json` 源规则集 + `<tag>.srs` 二进制 | sing-box |
| `generated/clash/` | `<tag>.yaml`，mihomo `behavior: classical` 的 payload | mihomo / clash 类客户端 |
| `generated/plain/` | `<tag>.list`，内容行原样保留（注释与空行已去除） | Loon / Surge 直接按 URL 引用 |

公开层的 DNS 规则引用到的清单，还会多产出一份 `<tag>-dns.{json,srs}`：只保留
`domain` / `domain_suffix` / `domain_keyword` / `domain_regex` 四类字段。

这是内核的硬要求，不是洁癖：DNS 规则在拿到响应之前只能按查询名判定，含 IP 条目的规则集
被 DNS 规则引用时，内核 1.14 起打废弃告警、1.16 起拒绝启动
（[迁移说明](https://sing-box.sagernet.org/migration/#migrate-address-filter-fields-to-response-matching)）。
所以 DNS 规则引用域名版（`ChinaMax-dns`），路由规则引用原版（`ChinaMax`）。
清单里没有域名类条目却出现在 DNS 规则里，构建会直接失败，而不是生成一份废弃写法。

另外生成 `config/sing-box/conf.d/45-ruleset.json`，里面是全部 `rule_set` 声明与按 policy 分组的路由规则。

`config/sing-box/conf.d/` 下只有两个文件：手写的公开层模板 `10-public.json`，与上面这份生成的
`45-ruleset.json`。按目录合并这两份时 sing-box 会按**文件名排序**、命令行传入的先后无效，因此
`10-public.json` 必须排在前面 —— 否则登记里的列表规则会先于内网直连规则命中。两者一旦改坏名字
（顺序翻转），`scripts/singbox_rules.py` 会直接报错拦下。设备拿到的配置不走目录合并，而是下面
这条合成路径：那里的先后由代码显式给出。

`45-ruleset.json` 与 `config/rules/generated/` 都是生成物，不要手工编辑，也已被 gitignore。它们是 CI 在 push 到 `main` 时生成并发布到 `sing-box-rules` 分支的。

## 合成：输入到完整配置

```
just check-singbox        # 用文档级夹具合成一份 darwin 配置并让内核校验
```

等价的直接调用：

```
uv run python -B scripts/singbox_rules.py compose --input <输入.json> --output -
```

输入是一份 JSON，五列：

| 键 | 必填 | 含义 |
|---|---|---|
| `target` | 是 | 目标端，目前只实现 `darwin`，其余值明确报错 |
| `subscription` | 否 | 订阅体（base64 或明文），由调用方抓好再传进来 |
| `nodes` | 否 | 节点分享链接，可重复；与订阅里的链接同等处理 |
| `dns` | 是 | 内网 DNS 地址 |
| `zone` | 是 | 内网域名后缀，生成 `zone-internal` 规则集 |

输出是一份完整的 sing-box 配置：公开层模板、内网解析器与内网规则集、节点出站与分流分组、
规则集登记（一律 `type: "remote"`，指向发布分支）。缺参数、参数非法、一个可用节点都没有
都会当场失败且不产出半成品；它是纯变换，不联网、不写仓库目录。

拼接顺序即优先级：公开层在最前（它的 `route.final` 与 `dns.final` 说了算，主分组与下载规则集
用的 HTTP client 都跟着它走），登记在最后（列表规则排在内网直连规则之后）。

## 客户端不支持的规则

各客户端能力不同，不支持的类型**跳过并记录，不中断构建**。被跳过的原始行写到
`generated/unsupported/<client>/<tag>.txt`。

- sing-box 不支持 `USER-AGENT`、`URL-REGEX`、`IP-ASN`、`SRC-GEOIP`、`SRC-IP-ASN`、
  `IN-PORT`、`PROTOCOL`。前两类单靠 TLS 嗅探拿不到；geoip 族匹配已在 sing-box 1.12.0 移除。
- mihomo 不支持 `USER-AGENT`、`URL-REGEX`。
- plain 不做任何过滤，全部原样保留，由 Loon / Surge 自己判断。

`GEOIP` / `GEOSITE` 不属跳过项：整个列表只有这类引用时，sing-box 的产物会退化为对
[sing-geoip](https://github.com/SagerNet/sing-geoip) / [sing-geosite](https://github.com/SagerNet/sing-geosite)
预编译规则集的引用。

## 测试

```
bun test scripts/singbox_rules.test.js
```

或 `just test-rules`。用例通过脚本的 `convert` 与 `compose` 子命令驱动纯转换逻辑，全程不触网，
因此不依赖任何外部列表的当前内容。

需要内核参与的那一层在沙箱里跑：

```
just test-sandbox
```

`config/sing-box/tests/compose.test.js` 会在沙箱内合成一份配置、让 `sing-box check` 校验，并真的
把它跑起来（本地投影节点 + TUN），断言启动、拉全规则集、无 FATAL —— 装配错误只有跑起来才现形。

## 发布产物

CI 把产物发布到 `sing-box-rules` 分支，可直接按 URL 引用：

```
https://raw.githubusercontent.com/shelken/proxy/sing-box-rules/plain/MyDirect.list
```

目录与上表一致：`singbox/`、`clash/`、`plain/`，外加根目录的 `45-ruleset.json`。

该分支是孤儿分支，每次 CI 运行都会整体重建（`git push --force`），只保留最新一次产物。
分支上还没有新目录时说明 CI 尚未跑成功，去 Actions 页面看 `build-rule-sets` 的结果。
