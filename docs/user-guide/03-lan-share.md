# 局域网共享本机代理

默认只有本机能用代理：底模的 `mixed-in` 监听 `127.0.0.1:2080`。要让局域网其他设备使用，用 [overlay](./02-overlay.md) 新增一个独立入站，不改动 `2080`

## 默认状态

| 入口 | 监听 | 认证 | 用途 |
| :--- | :--- | :--- | :--- |
| `mixed-in` | `127.0.0.1:2080` | 无 | 本机程序，底模自带 |
| `mixed-lan` | 默认不存在 | 用户名密码 | 局域网共享，按下文开启 |

## 开启

在客户端 `config.yaml` 的 `overlay` 中加入，把密码换成自己的随机值，再重新 `encode` 并覆盖 SFM 里的订阅 URL，步骤见 [01-mac-sfm.md](./01-mac-sfm.md)

```yaml
overlay: |
  {
    "inbounds": [
      {
        "type": "mixed",
        "tag": "mixed-lan",
        "listen": "0.0.0.0",
        "listen_port": 2081,
        "users": [{ "username": "lan", "password": "<随机密码>" }]
      }
    ],
    "route": {
      "rules": [
        { "inbound": ["mixed-lan"], "action": "route", "outbound": "proxy" }
      ]
    }
  }
```

| 字段 | 作用 |
| :--- | :--- |
| `listen` | `0.0.0.0` 接受局域网连入，改成本机局域网 IP 则只在该网卡监听 |
| `listen_port` | 避开 `2080`，两个入口互不影响 |
| `users` | 必填。没有认证时局域网内任何设备都能用你的出口 |
| `route.rules` | 把这个入口的所有流量固定交给 `proxy` 出站 |

overlay 的路由规则排在底模所有规则之前，所以这条规则先生效

## 为什么固定走 proxy

不固定时，局域网设备请求 `127.0.0.1` 或 `localhost`，会被底模的私网直连规则送到本机，读到本机服务。固定出站后，请求交给代理节点，不会在本机直连

代价：共享入口不做国内直连分流，访问国内站点也经过代理

## 使用与验证

局域网设备把代理设为本机 IP 的 `2081`，协议选 HTTP 或 SOCKS5，填入用户名密码。验证命令

```bash
curl -x socks5h://lan:<随机密码>@<本机局域网IP>:2081 https://example.com
```

不带用户名密码时连接被拒绝

## 关闭

删除 `overlay` 中的 `inbounds` 与 `route` 两段，重新 `encode` 并覆盖订阅 URL

## 注意

- 本文的认证与固定出站在沙箱内以 `127.0.0.1` 监听验证，局域网设备能否连入取决于你的网络与系统防火墙
- iOS 底模拒绝 Tailnet 连入 sing-box 路由的流量；Mac 的系统 Tailscale 是否可达 `2081` 取决于 Mac 上 Tailscale 的监听设置，不在本文范围
