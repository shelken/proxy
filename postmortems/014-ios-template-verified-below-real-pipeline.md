# iOS 底模验证止于内核 check，缺口由 CI 与外部审查才暴露

**日期**: 2026-10-17
**影响**: PR #127 首次推送后 CI 失败，随后外部审查发现 1 个 P1 与 3 个 P2。本地全套检查当时全部通过，装配链路从未被真实执行
**发现人**: CI、reviewer-gpt、用户

## 问题

为 iOS 新增 `template-ios.json` 后，本地只跑了 `sing-box check`、模板结构测试和沙箱 DNS 测试，就认为完成。后来依次暴露：CI 在 Linux 失败；DNS 层漏掉 `ts-ep` 入站拒绝；测试对被篡改的配置仍全过；客户端实际走 `template_url` 装配，而我从未让底模经过 sbtools 装配

## 现象

```sh
# CI（GNU coreutils）
cp config/sing-box/modules/*.json config/sing-box/modules-ios/*.json "$ios"
# cp: will not overwrite just-created '.../00-inbounds.json' with '.../modules-ios/00-inbounds.json'

# 变异验证：删掉 dns-ts 的 preferred_by，路由 preferred_by 改成 missing-endpoint
bun test config/sing-box/tests/ios-template.test.ts   # 7 pass / 0 fail
```

## 根因

- 错误假设：`cp a/*.json b/*.json dest` 在 macOS 与 GNU 上行为一致。GNU 拒绝同一条命令里用同名文件覆盖刚复制的文件
- 错误假设：路由层的入站拒绝覆盖全部入站路径。Tailscale 依赖把 Peer 的 DNS 查询直接交给 `dnsRouter`，不经 `route.rules`
- 错误假设：`template.json` 只是编译期内嵌，改它要重新部署服务端。实际客户端习惯用 `template_url`，改后即时生效
- 缺失检查点：没有任何测试让 `template-ios.json` 经过 `finalize` 与内核 `check`。结构断言也只检查字段存在，没有锁定取值，内核 merge 又会省略默认值，断言容易被掩盖

## 修复

- 两步复制，并在 Lima（Linux）里按 CI 脚本实跑
- DNS 层首条加 `inbound: ts-ep` 的 `reject`，用同标签入站复现 REFUSED
- 测试断言实际 tag 与取值，并用变异验证确认会失败
- 新增 `scripts/sbtools-rs/tests/ios_template.rs`，让 iOS 底模走真实装配后再跑内核 check

## 预防

- 新增或修改任何底模，先在 `scripts/sbtools-rs/tests/` 让它经过 `finalize` 与内核 `check`，再宣布完成
- 写完结构断言，必须做一次变异验证：改坏被测字段，断言应失败；仍通过说明断言没锁住取值
- 改动 justfile 或 CI 脚本里的 shell，必须在 Lima 的 Linux 环境按 CI 同样的脚本跑一遍，不能只在 macOS 本机跑
- 设计入站隔离时，同时核对路由层与 DNS 层：到源码确认该入站是否进入 `route.rules`，不能默认两层规则互相覆盖
- 讨论部署路径前，先读 `docs/user-guide/` 中客户端实际用法（如 `template_url`），不能只凭代码里的默认路径推断
