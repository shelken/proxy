# overlay 覆盖与自定义 host

`overlay` 是写在客户端 `config.yaml` 里的原生 sing-box JSON，随订阅密文一起送到服务端，
在官方 `sing-box merge` 里叠加到底模之上。用途：给单个设备加本地规则，不动服务端底模。

服务端合并顺序是 `00-direct` → `01-overlay` → `02-base`。标量（`log.level` 这类）取首份，
所以 overlay 能覆盖底模；数组按序拼接，所以 **overlay 的 `dns.rules` 会排在底模所有规则之前**。

## 自定义 host

把域名固定到一个 IP，用 `hosts` 类型的 DNS server 加一条 `preferred_by` 规则：

```yaml
overlay: |
  {
    "dns": {
      "servers": [
        {
          "type": "hosts",
          "tag": "dns-hosts",
          "predefined": {
            "photo.int.ooooo.space": "192.168.69.46",
            "minio-ui.int.ooooo.space": "192.168.6.144"
          }
        }
      ],
      "rules": [
        { "preferred_by": ["dns-hosts"], "action": "route", "server": "dns-hosts" }
      ]
    }
  }
```

| 字段 | 作用 |
| :--- | :--- |
| `predefined` | 域名到 IP 的映射，键是完整域名，值可以是单个 IP 或 IP 数组 |
| `preferred_by` | 匹配 `dns-hosts` 里有映射的域名，命中即走该 server |
| `server` | 命中的查询交给哪个 server 应答 |

要点：

- `preferred_by` 的值是 **server 的 tag**（`["dns-hosts"]`），不是类型名 `"hosts"`
- `predefined` 的键**只支持完整域名**，写 `*.int.ooooo.space` 不会命中任何查询
- 只影响列出的域名；其余域名照常走底模规则

通配（一个后缀下所有名字指向同一 IP）用 `predefined` 动作，不用 `hosts`：

```yaml
overlay: |
  {
    "dns": {
      "rules": [
        { "domain": ["int.ooooo.space"], "action": "predefined" },
        { "domain_suffix": [".int.ooooo.space"], "query_type": ["A"],
          "action": "predefined", "answer": ["*. IN A 192.168.69.46"] },
        { "domain_suffix": [".int.ooooo.space"], "action": "predefined" }
      ]
    }
  }
```

`answer` 里写 `*.` 即可，sing-box 会把 `*` 换成查询名，不需要在 `answer` 里重复域名。
第一条挡根名（否则通配改写对根名不生效，会漏出字面 `*` 记录），第三条把 AAAA 等其余
类型答成空结果，避免落到 FakeIP。

## 生效与验证

改完 overlay 后重新 `encode` 并把新 URL 覆盖进 SFM，见 [01-mac-sfm.md](./01-mac-sfm.md)。
落地的配置可在 SFM 面板的 `Connections` 页看命中的规则序号。

查询验证：

```bash
# 直接问 SFM 内核（198.51.100.2 是 TUN 网段里的内核 DNS 地址）
dig @198.51.100.2 photo.int.ooooo.space A

# 用 sbtools trace 看判定链路
sbtools trace photo.int.ooooo.space
```

## 限制

- **不能按 tag 覆盖底模已有的 `dns.servers` 条目**：overlay 是数组追加语义，同 tag 会并存而非替换
- 上层字段名写错会直接报错，不会被静默忽略
- `overlay` 与 `template_url` 下载的底模都不得含 `certificate_path` / `key_path` /
  `private_key_path` / `config_path`，需要证书时改为内联内容
