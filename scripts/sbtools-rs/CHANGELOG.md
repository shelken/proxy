# Changelog

## [0.7.1](https://github.com/shelken/proxy/compare/v0.7.0...v0.7.1) - 2026-10-01

### Fixed

- *(sbtools)* 消除擅自改变命令行为的静默退化 ([#85](https://github.com/shelken/proxy/pull/85))

## [0.7.0](https://github.com/shelken/proxy/compare/v0.6.1...v0.7.0) - 2026-09-30

### Other

- 统一 sbtools 配置加载与 controller 决议

## [0.6.1](https://github.com/shelken/proxy/compare/v0.6.0...v0.6.1) - 2026-09-30

### Fixed

- *(config)* 配置的非回环 controller 显式拒绝并跳过摘要

### Other

- Merge pull request #78 from shelken/fix/config-controller-guard

## [0.6.0] - 2026-09-30

全仓改名 sb-sync → sbtools:二进制、镜像(ghcr.io/shelken/proxy/sbtools-server)与 CLI 名称同步更名。新增三个子命令:config(隐私化查看生效配置)、logs(实时日志跟踪)、trace(全链路探测,新增 live 归属/静态规则/dns 推演段)。mise(ubi/vmg 后端)用户需重装:二进制名已从 sb-sync 变为 sbtools,旧安装不会自动迁移。

## [0.5.5](https://github.com/shelken/proxy/compare/v0.5.4...v0.5.5) - 2026-09-29

### Added

- *(dns)* dns-proxy 出口改走 hk 测速组，装配器回退悬空 detour

### Fixed

- *(sb-sync)* lib 内 unwrap 被 clippy 拒绝，改 unwrap_or_default
- *(template)* 保留 HTTPS 记录并新增经代理兜底的加密 DoH

### Other

- *(assemble)* 在真实装配产物上验证策略组可达性与 tailscale 移除
- *(assemble)* 恢复策略组顺序断言并同步移除已删除的 tailscale 组
- *(template)* 移除无法证明SSH修复的结构断言并记录验证失误

## [0.5.4](https://github.com/shelken/proxy/compare/v0.5.3...v0.5.4) - 2026-09-29

### Fixed

- *(trace)* 无 id 的 DNS 判定按相邻 exchange 行回填，路由缺失按 exclude 分层
- *(trace)* 不丢无请求号的日志，采集窗口等到达拨号证据
- *(trace)* 报出站拨号解析路径，沙箱不再替换 local resolver
- *(trace)* 决策按请求号关联域名，fakeip 不计成功，失败分类并可检出控制面不可达
- *(sb-sync)* 策略组剔除后剪掉对它的悬空引用

### Other

- Merge pull request #56 from shelken/fix/trace-correctness
- *(rules)* 规则集 1024 改名为 1024proxy

## [0.5.3] - 2026-09-24

Cargo workspace 上移仓库根：修复 release-plz git_only 在子目录清单下找不到 Git 仓库的问题，自动版本 PR 恢复可用；CI 缓存键与发版校验路径同步

## [0.5.2] - 2026-09-24

恢复并增强 trace 子命令，通过内核 debug 日志流全链路探测 DNS/路由决策与链路

## [0.5.1] - 2026-09-24

统一版本真源：Cargo.toml 成为唯一版本来源，CI 只校验不改写；发布链路改为先校验、再构建三平台二进制与双架构镜像，全部通过后才公开带资产的 Release。

