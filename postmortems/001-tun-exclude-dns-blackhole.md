# TUN 网段与 route_exclude_address 自相矛盾导致系统 DNS 黑洞

**日期**: 2026-09-19
**影响**: SFM 接管网络期间，系统栈所有"新域名"解析 5~15s 超时；浏览器靠 DNS 缓存掩盖，缓存过期即出现网页加载 4s+，整体体验显著慢于 Loon
**发现人**: 用户（浏览器访问 Twitter 图片异常慢）

## 问题

SFM/sing-box 接管网络后，任何未被缓存的新域名解析全部超时。浏览器对访问过的站点看似正常（缓存命中），新站点或缓存过期的站点动辄数秒才打开，且故障是间歇性的（缓存新旧决定快慢），极难直觉定位。

## 现象

```bash
# 系统解析器指向 TUN 劫持地址
scutil --dns | head -6
#   nameserver[0] : 172.19.0.2  (utun5)

# 任何新域名解析超时
dig +short +time=3 +tries=1 www.wikipedia.org
# ;; connection timed out; no servers could be reached   (5s)

# 但发往劫持地址的 UDP 53 连通性测试反而"成功"（TCP 探测假象）
nc -vzu 172.19.0.2 53   # succeeded

# 内核日志(clash API /logs)完全看不到 dig 发出的查询 → 包根本没进内核
curl -sN http://127.0.0.1:9090/logs?level=debug | grep dns   # (无 twimg/wikipedia 行)
```

底模配置的自相矛盾（`config/sing-box/template.json`）：

```json
"tun": {
  "address": ["172.19.0.1/30"],        // 劫持 DNS 地址 = 172.19.0.2
  "route_exclude_address": [
    "10.0.0.0/8",
    "172.16.0.0/12",                    // ← 172.19.0.0/30 落在这个排除段!
    ...
  ]
}
```

## 根因

**实际约束**：sing-box 1.14 `dns_mode: hijack` 把 DNS 劫持地址放在 TUN 网段内（`tun.address` 下一跳），macOS 系统解析器被指向该地址（scutil 可见）。`route_exclude_address` 的语义是"发往这些网段的包不进 TUN"。

**错误假设**（写配置时）："排除内网网段只影响去往内网的业务流量，不影响 TUN 自身的控制面"。事实上系统解析器恰好指向被自己排除的网段，DNS 查询包被排除路由直接绕过 TUN，内核永远收不到。

**为什么难发现**：
1. 浏览器/系统有 DNS 缓存，命中时一切正常，故障只出现在冷域名——间歇性掩盖持续故障
2. `nc -vzu` 探测显示"succeeded"（UDP 无连接，nc 只验证了 sendto 不报错），假阴性
3. `curl` 的 DNS 计时 3ms（命中 getaddrinfo 缓存），与浏览器体验矛盾
4. 内核日志无任何 error——包在进 TUN 之前就被系统路由表吞了，sing-box 毫无感知

**缺失的检查点**：没有任何一步验证"系统解析器地址从内核视角可达"。

## 修复

TUN 网段改用 `198.18.0.1/30`（RFC 2544 基准测试保留网段，真实网络不会用到，也不在任何排除列表内），排除列表保持原样——内网直连需求不受影响，劫持地址 `198.18.0.2` 的包正常进入 TUN 被内核应答。commit `8362183`。

## 预防

- TUN 网段必须避开 `route_exclude_address` 覆盖范围：改 `tun.address` 或 `route_exclude_address` 任一后，执行 `python3 -c "import ipaddress, json; t=json.load(open('config/sing-box/template.json'))['inbounds'][0]; [print('CONFLICT') for ex in t['route_exclude_address'] for a in t['address'] if ipaddress.ip_network(a.split('/')[0]+'/32').subnets_of(ipaddress.ip_network(ex))]"` 之类的网段包含检查（已计划固化为 sb-sync check 项）
- 配置变更后必须做"系统解析器可达性"端到端验证，而非只跑 `sing-box check`（check 只验语法）：
  1. `scutil --dns | head` 确认解析器地址
  2. `dig +short +time=2 +tries=1 <从未访问过的域名>`（用随机子域避开一切缓存，如 `test$(date +%s).example.com` 的 NS 或直接一个生僻域名）必须在 2s 内返回或 NXDOMAIN，超时即失败
- UDP"连通性测试"不要用 `nc -vzu`（UDP 无连接恒假阴性）；以"是否收到预期应答"为准（dig 有输出或明确 NXDOMAIN）
- 内核侧零日志 + 系统栈超时的组合 = 包没进内核，先查路由表（`netstat -rn | grep <网段>`）再查内核配置

## 后续补充（同日引入 FakeIP 时追加）

1. **"SFM 会把 TUN 网段改写为 172.19.0.1/30"是当时的错误归因**。实机验证
   （`scutil --dns` 解析器 = 配置写的 198.18.0.2；源码 `libbox/tun.go` 平台接口
   原样透传 `Inet4Address`）：SFM/libbox 完全尊重配置里的 `tun.address`，不改写。
   当时 scutil 看到 172.19.0.2 只是因为产物本来就是旧底模生成的 172.19。
2. **FakeIP 引入后的新约束**：fakeip 池与 TUN 网段也必须互斥。
   源码 `dns/transport/fakeip/store.go` 分配是**从池首地址顺序递增**
   （`inet4Current = inet4Range.Addr().Next()`，即 198.18.0.1 起），
   TUN 若落在池内会与假 IP 争用地址。
3. **最终网段方案**：TUN `198.51.100.1/30`（TEST-NET-2，不在排除段、不在池内）
   + FakeIP 池 `198.18.0.0/15` + 排除段不动。三方互斥已固化为
   `template.test.ts::"TUN 网段与排除段、FakeIP 池三方互斥"` 断言。
