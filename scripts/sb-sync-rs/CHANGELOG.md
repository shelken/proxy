# Changelog

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

