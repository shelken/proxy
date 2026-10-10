# overlay 覆盖与自定义 host

`overlay` 是写在客户端 `config.yaml` 里的原生 sing-box JSON，随订阅密文一起送到服务端，在官方 `sing-box merge` 里叠加到底模之上；用于给单个设备增加本地规则，不修改服务端底模

服务端合并顺序是 `00-direct` → `01-overlay` → `02-base`；标量取首份，overlay 能覆盖底模标量；数组按序拼接，overlay 的 `dns.rules` 会排在底模所有规则之前

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

- `preferred_by` 的值是 server 的 tag，不是类型名 `hosts`
- `predefined` 的键只支持完整域名，写通配符不会命中查询
- 仅影响显式列出的域名，其余域名按底模规则处理

通配后缀场景采用 `predefined` 动作：

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

`answer` 中写 `*.` 即可，sing-box 会自动替换为查询名，无需重复域名
首条规则拦截根域名，尾条规则将 AAAA 等其余记录响应为空，避免落入 FakeIP

## 生效与验证

修改 overlay 后重新 `encode` 并将新 URL 覆盖进 SFM，见 [01-mac-sfm.md](./01-mac-sfm.md)
生效配置可在 SFM 面板的 Connections 页查看命中规则

查询验证：

```bash
# 直接问 SFM 内核（198.51.100.2 是 TUN 网段里的内核 DNS 地址）
dig @198.51.100.2 photo.int.ooooo.space A

# 用 sbtools trace 看判定链路
sbtools trace photo.int.ooooo.space
```

## 限制

- **不能按 tag 覆盖底模已有的 `dns.servers` 条目**：overlay 为数组追加语义，同 tag 会并存而非替换
- 上层字段名拼写错误会直接报错，不会静默忽略
- `overlay` 与 `template_url` 下载的底模均不得包含路径引用字段，需要证书时使用内联内容
