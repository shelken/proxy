# 发布操作

`sbtools` 的版本真源是 `scripts/sbtools-rs/Cargo.toml`；仓库根的 `Cargo.toml` 只是把该 crate 纳入 workspace 的清单，不含版本。合并一个 Release PR 后，CI 自动产出三平台二进制、双架构镜像和带资产的 GitHub Release
全流程只用仓库自带的 `GITHUB_TOKEN`，不需要任何个人访问令牌或 GitHub App

## 常规发布

1. 功能 PR 合并到 `main`
2. `release-plz` 工作流自动开一个版本 PR，按 conventional commits 推导版本并更新 `Cargo.toml`、`Cargo.lock`、`CHANGELOG.md`
3. 核对版本号、CHANGELOG 说明与 CI 结果，Merge
4. 合并后 `release-sbtools` 检测到清单版本变化，创建 tag、构建产物、公开 Release

不要手工推 tag，也不要手改 `Cargo.toml` 版本

> workspace 清单必须留在仓库根。release-plz 的 `git_only` 模式在清单所在目录打开 Git 仓库，且不向上层搜索 `.git`；把它放回 crate 子目录会导致无法定位仓库并中止版本推导

## 指定版本，或只改了包外文件

底模、`.mise.toml`、`Dockerfile` 等 crate 外改动不会进入自动版本 PR，通过表单指定：
Actions → `release-plz` → Run workflow → 填 `version`（三段式 X.Y.Z，不带 v 前缀）与 `notes`（写入 CHANGELOG 的说明），等待生成的 PR 通过 CI 后合并

```sh
gh workflow run release-plz.yml --ref main -f version=<version> -f notes='本次发布说明'
```

版本必须严格大于当前清单版本与所有已发布 tag，否则脚本在写入任何文件之前失败；自动版本 PR 由 release-plz 自己维护，同时存在的多余版本 PR 会被自动关闭

## 快照验证

仅验证构建链路（不发版、不建 tag、不动 `latest`）：

```sh
gh workflow run release-sbtools.yml --ref <分支或 tag>
```

产物是 `snapshot-<sha>` 一次性镜像 tag 与 run artifact；包属于公开包，GHCR 对公开包不计量存储，快照无需定期回收

## 失败处理

- 优先 Re-run failed jobs；同一个版本不移动 tag，需要改代码或工作流时发新的 patch 版本
- 是否算作已发布以 GitHub Release 是否存在为准，不看 tag；构建中途失败会留下已建但未发布的 tag，重跑时 prepare 步骤会自动复用
- 发布完成的判据是 release job 成功且 GitHub Release 产出三份二进制与 `SHA256SUMS`，GHCR 镜像标签指向双架构 digest
## 其他

- 沙箱 VM 内核版本取自 `just vm-create` 执行时的 `.mise.toml`，已存在的 `proxy-test` VM 不自动换内核，需要时 `just vm-delete` 后重建
- 客户端已安装的二进制不随发版自动升级，`latest` 仅为镜像便利标签，升级命令见 `docs/user-guide/00-cli-sync.md`
- 服务端部署由 home-ops 的 VPS Docker Compose 完成，本仓库只负责产出产物
