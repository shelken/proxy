# 静态检查冒充复现，空 direct detour 引入启动错误

**日期**: 2026-09-29
**影响**: 底模审查把未验证推断评为严重缺陷，本地配置加入不必要的 HTTPS 拒绝与导致内核启动失败的 detour；用户要求重新审查时该分支尚未推送
**发现人**: 用户质疑 Type 65 拒绝依据后，隔离 VM 实验检出

## 问题

将社区配置示例当成 sing-box 官方要求；真实网络测试启动失败后，改用打印配置字段的脚本，却仍宣称完成沙箱复现

## 现象

`sing-box check` 能通过增加 detour 的配置，但 1.14.1 内核实际运行返回：

```text
start service: start dns/udp[cn]: detour to an empty direct outbound makes no sense
```

HTTPS reject 返回 REFUSED，无法证明它是正确的隐私策略。未设置 rcode 的 predefined 实测返回 NOERROR 空答案，没有复现此前声称的解析悬挂

## 根因

- 错误假设：所有 DNS server 都依赖路由兜底选择出站。实际约束：新格式 UDP DNS 默认使用直连拨号
- 错误假设：有社区拒绝 HTTPS 的示例，就代表所有 FakeIP 配置都需要拒绝。实际约束：HTTPS 是标准服务参数记录，需要根据用户目标选择查询出口
- 缺失检查：没有确认内核就绪、没有观测查询响应与出口，没有区分配置存在、静态推断和运行复现
- 缺失边界：Linux 沙箱结果不能直接证明 macOS NetworkExtension 行为；底模不能替代包含反回环层的最终配置

## 修复

撤销 HTTPS 拒绝和空 direct detour。按用户选择通过代理加密 DNS 处理兜底查询。使用独立网络命名空间验证启动、真实 SOCKS→TLS DoH 链、DNS 响应码、缓存正常重启及路由差异，保留行为测试和审查工件

## 预防

- 每项严重缺陷必须附实际失败信号；启动失败时不能把后续请求超时归因于被测功能
- 配置修改同时跑 check 和 run，就绪后再发查询，不能只比较字段
- 引用社区建议时标明其来源与适用版本；默认行为用官方文档及锁定版本内核交叉验证
- 更改 DNS 查询类型处理前记录兼容性代价；查询出口问题优先评估出口策略
- 复现脚本不得写死结论文本代替断言；生产模板行为验证入口见 [ARCH.md 的沙箱闭环](../docs/ARCH.md) 与 `.agents/skills/verify-rules-compiler/SKILL.md`
