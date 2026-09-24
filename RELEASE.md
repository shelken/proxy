# 发布操作

`sb-sync` 的版本真源是 `scripts/sb-sync-rs/Cargo.toml`。合并一个 Release PR 后，CI 自动产出三平台二进制、双架构镜像和带资产的 GitHub Release。

## 常规发布

1. 功能 PR 合并到 `main`
2. `release-plz` 工作流自动开一个版本 PR（版本按 conventional commits 推导，更新 `Cargo.toml`、`Cargo.lock`、`CHANGELOG.md`）
3. 核对版本号、CHANGELOG 说明与 CI 结果，Merge
4. Merge 触发 `release-plz` 按清单版本打 tag，进而触发 `release-sb-sync` 构建

不要手工推 tag，也不要手改 `Cargo.toml` 版本。

## 指定版本，或只改了包外文件

底模、`.mise.toml`、`Dockerfile` 等 crate 外改动不会进入自动版本 PR，用表单指定：

Actions → `release-plz` → Run workflow → 填 `version`（`X.Y.Z`，不带 `v` 前缀）与 `notes`（写入 CHANGELOG 的说明）→ 等生成的 `release-plz-manual` PR 通过 CI 后合并。

```sh
gh workflow run release-plz.yml --ref main -f version=0.6.0 -f notes='底模路由调整'
```

版本必须严格大于当前清单版本与所有已发布 tag，否则脚本在写入任何文件之前失败。手动准备的 PR 创建成功后，旧的机器人版本 PR 会被自动关闭并留评论指向新 PR。

## 快照验证

只想验证构建链路（不发版、不动 `latest`）：

```sh
gh workflow run release-sb-sync.yml --ref <分支或 tag>
```

产物是 `snapshot-<sha>` 一次性镜像 tag 与 run artifact。超过 14 天的快照镜像由 `cleanup-snapshot-images.yml` 每日回收；该工作流也可手动 dry-run：

```sh
gh workflow run cleanup-snapshot-images.yml -f dry_run=true
```

## 失败处理

- 优先 Re-run failed jobs。同一个 tag 不移动；需要改代码或改工作流时，发新的 patch 版本
- 发布完成的判据是 `release` job 成功，且 GitHub Release 有三份裸二进制加 `SHA256SUMS`，GHCR 上 `vX.Y.Z` 与 `latest`（当它是最新版本时）指向同一双架构 digest。tag 存在、release-plz 成功都不代表发布完成
- `RELEASE_PLZ_TOKEN` 是必需的仓库级 fine-grained PAT（Contents 与 Pull requests 读写），否则版本 PR 触发不了后续 CI，tag 也触发不了发布工作流

## 依赖的前提

- 仓库 Settings → Actions → General 需允许 GitHub Actions 创建 PR
- GHCR 包 `proxy/sb-sync-server` 的 Manage Actions access 需把本仓库列为 Admin，否则清理工作流无权删除镜像

## 其他

- 沙箱 VM 的内核版本取自 `just vm-create` 执行时的 `.mise.toml`。已存在的 `proxy-test` VM 不会自动换内核，需要时 `just vm-delete` 后重建
- 客户端已安装的二进制不会随发版自动升级；`latest` 只是镜像便利入口
- 集群部署仍由 home-ops 的 Renovate 版本/digest PR 与 Flux 完成，本仓库只负责产出
