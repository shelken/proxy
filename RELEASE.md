# 发布操作

`sb-sync` 的版本真源是 `scripts/sb-sync-rs/Cargo.toml`。合并一个 Release PR 后，CI 自动产出三平台二进制、双架构镜像和带资产的 GitHub Release。

全流程只用仓库自带的 `GITHUB_TOKEN`，不需要任何个人访问令牌或 GitHub App。

## 常规发布

1. 功能 PR 合并到 `main`
2. `release-plz` 工作流自动开一个版本 PR（版本按 conventional commits 推导，更新 `Cargo.toml`、`Cargo.lock`、`CHANGELOG.md`）
3. 核对版本号、CHANGELOG 说明与 CI 结果，Merge
4. 合并后 `release-sb-sync` 检测到清单版本变化，创建 tag、构建产物、公开 Release

不要手工推 tag，也不要手改 `Cargo.toml` 版本。

## 指定版本，或只改了包外文件

底模、`.mise.toml`、`Dockerfile` 等 crate 外改动不会进入自动版本 PR，用表单指定：

Actions → `release-plz` → Run workflow → 填 `version`（`X.Y.Z`，不带 `v` 前缀）与 `notes`（写入 CHANGELOG 的说明）→ 等生成的 PR 通过 CI 后合并。

```sh
gh workflow run release-plz.yml --ref main -f version=0.6.0 -f notes='底模路由调整'
```

版本必须严格大于当前清单版本与所有已发布 tag，否则脚本在写入任何文件之前失败。自动版本 PR 由 release-plz 自己维护，同时存在的多余版本 PR 会被它关闭。

## 快照验证

只想验证构建链路（不发版、不建 tag、不动 `latest`）：

```sh
gh workflow run release-sb-sync.yml --ref <分支或 tag>
```

产物是 `snapshot-<sha>` 一次性镜像 tag 与 run artifact。包是公开包，GHCR 对公开包不计量存储，这些快照不需要定期回收。

## 失败处理

- 优先 Re-run failed jobs。同一个版本不移动 tag；需要改代码或改工作流时，发新的 patch 版本
- 版本是否算「已发布」只看 GitHub Release 是否存在，不看 tag。构建中途失败会留下已建但未发布的 tag，直接重跑即可继续——`prepare` 会复用它，不会因为 tag 已存在而跳过
- 发布完成的判据是 `release` job 成功，且 GitHub Release 有三份裸二进制加 `SHA256SUMS`，GHCR 上 `vX.Y.Z` 与 `latest` 指向同一双架构 digest。tag 存在、工作流转绿都不代表发布完成

## 其他

- 沙箱 VM 的内核版本取自 `just vm-create` 执行时的 `.mise.toml`。已存在的 `proxy-test` VM 不会自动换内核，需要时 `just vm-delete` 后重建
- 客户端已安装的二进制不会随发版自动升级；`latest` 只是镜像便利入口
- 集群部署仍由 home-ops 的 Renovate 版本/digest PR 与 Flux 完成，本仓库只负责产出
