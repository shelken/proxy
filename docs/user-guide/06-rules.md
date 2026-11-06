# 分组与分流

日常只改一个文件：`config/sing-box/settings.yaml`。`groups` 定义客户端面板里显示的分组，`rules` 定义每条规则走哪个分组。Mac、iOS、路由器三份底模共用这一份，改一次三端生效

## 配置

```yaml
groups:
  openai:
    options: [selfhost, proxy, "(?i)(港|日本|台湾|GPT|美)"]
    default: selfhost
rules:
  - { name: OpenAI, source: ../rules/custom/OpenAI.yaml, to: openai }
  - { name: Facebook, source: geosite:facebook, to: proxy }
  - { name: tracking, source: https://example.com/tracking.srs, to: reject }
```

| 字段 | 作用 |
| :--- | :--- |
| `groups.<名>.options` | 候选，写已有分组名或节点名正则 |
| `groups.<名>.default` | 默认候选，不写则取第一个 |
| `rules[].name` | 规则名，同时是规则集标签与产物文件名 |
| `rules[].source` | `config/rules/custom/*.yaml`、`geosite:x`、`geoip:x` 或外部 `.srs` 链接 |
| `rules[].to` | `reject`、`direct` 或某个分组名 |

规则的书写顺序就是匹配顺序。`to: reject` 与 `to: download` 的规则由模板固定在前面，不受位置影响。地区自动测速组和 `proxy`、`selfhost` 等也在 `groups` 里，自动测速组的写法见文件里的 `x-urltest`

## 常见操作

- 加域名：改 `config/rules/custom/<规则>.yaml`
- 引入一个现成的 `.srs`：在 `rules` 加一行，`source` 写链接，`to` 写去向，例如拦截写 `reject`
- 新增分组：在 `groups` 加一项，再让规则的 `to` 指向它
- 调整面板里分组的显示顺序：调整 `groups` 的书写顺序，`proxy` 总是排第一

## 生成与检查

```bash
just template-build    # 重新生成三份底模
just template-check    # 校验生成结果与源文件一致
```

规则产物由 CI 编译并发布到 `sing-box-rules` 分支，合并到 `main` 后客户端按天拉取

## 注意

- 平台模板与 `shared.yaml` 按名字引用部分规则（`MyProxy`、`ChinaMax`、`Lan`、`MyReject`、`MyDirect`、`cftunnel`、`geoip-cn`）。删除或改名这些规则时构建会报错并点名规则，需要同时改 `shared.yaml`
- `ChinaMax`、`Lan`、`cftunnel`、`geoip-cn` 的 UDP 443 与 80 被强制送往直连，它们的 `to` 必须是 `direct`，否则构建报错
- 没有匹配 `selfhost` 节点的订阅，直指 `selfhost` 的规则会由 sbtools 回退到 `proxy`
- 底模结构与设计决策见 [ADR-0015](../adr/0015-settings-yaml-single-entry.md)
