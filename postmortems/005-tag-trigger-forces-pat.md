# tag 作为发布触发点，迫使引入长期 PAT

**日期**: 2026-09-24
**影响**: 发布链路的设计初稿引入了一个必须人工维护的 fine-grained PAT（`RELEASE_PLZ_TOKEN`）。凭据本身不是必需的——是触发点选错了才产生这个依赖。更隐蔽的后果是：为绕开 token 限制而让 release-plz 自己创建 GitHub Release，会让发布工作流「Release 已存在即跳过」的判据永久挡住真正的发布（无资产的 Release 挡在有资产的 Release 前面）
**发现人**: 用户质疑（「为什么需要生成 token？仓库本身不支持 PR 读写吗」），非 CI

## 问题

`release-sb-sync.yml` 原以 `on.push.tags: v*` 作为发布触发点。引入 release-plz 做自动版本后，tag 由 release-plz 推送——而 `GITHUB_TOKEN` 创建的 tag 不会触发 `push` 事件，发布工作流根本不会跑。当时的第一反应是「加一个 PAT」。

用户提出质疑后回查官方文档，确认这才是约束：

> When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following exceptions:
> - `workflow_dispatch` and `repository_dispatch` events always create workflow runs.
> - `pull_request` events with the `opened`, `synchronize`, or `reopened` activity types: … created in an **approval-required** state.

即：仓库自带的 `GITHUB_TOKEN` 在权限上完全够用（`contents: write` 能建 tag、`pull-requests: write` 能建 PR），受限的只是「由它触发的事件不再触发新 run」。而 `workflow_dispatch` 是明确的例外。

## 现象

症状不是报错，而是**静默**：tag 建出来了、tag 上的 workflow 不跑。定位方式是比对官方例外清单与实操现象：

```console
# 用 GITHUB_TOKEN 建的 tag 存在，但对应的 workflow run 不存在
$ gh api repos/OWNER/REPO/git/ref/tags/v0.5.1 --jq .ref
refs/tags/v0.5.1
$ gh run list --workflow=release-sb-sync.yml --limit 3
（无该 tag 的 run）
```

社区里同类问题（`orgs/community#25973`、`googleapis/release-please#1142`）给出的结论一致，根因都是「token 触发的事件被抑制」，而不是「API 建 tag 不触发」。

## 根因

**错误假设**：「要自动打 tag 并让 tag 触发发布，就需要一个有额外权限的 token」。实际约束是事件的抑制规则，与 token 权限无关；`GITHUB_TOKEN` 权限足够，只是它触发的事件被有意屏蔽（防递归）。

**选错的是触发点**：把 tag 当成「跨工作流的信号」。一旦接受这个前提，就只能用 PAT / GitHub App 绕开——依赖不是一个凭据，而是「必须有凭据」这个结构性约束。

**缺失的检查点**：动手前没有先枚举「这个自动化需要哪些事件，各自能否被 `GITHUB_TOKEN` 触发」。官方那张例外表 30 秒能查完。

## 修复

把 tag 从**触发条件**降级为**同一次 run 内的产物**：

```diff
- on:
-   push:
-     tags: ["v*"]
+ on:
+   push:
+     branches: [main]
```

`prepare` job 校验通过后建 tag，随后同 run 内构建、发布。全程只用 `GITHUB_TOKEN`，零额外凭据。附带的两处必须同步修改：

- **已发布判据从「tag 存在」改为「Release 存在」**：构建中途失败会留下已建但未发布的 tag，若拿 tag 当判据，该版本再也发不出来
- **并发 push 用 workflow 级 `concurrency` 串行化**：第二个 run 的 `prepare` 会看到 Release 已存在而自行跳过

同时把 `release-plz` 的 `git_release_enable` 保持 `false`（它不得自建 Release），并确认仓库设置 `can_approve_pull_request_reviews` 为真（否则 `GITHUB_TOKEN` 建 PR 会 403）。

## 预防

- **给发布链路选触发点前，先查官方的 token 例外表**，逐事件确认能否被 `GITHUB_TOKEN` 触发。查法：读 `docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow` 的 "Triggering a workflow from a workflow" 一节。`push`（含 tag）会被抑制；`workflow_dispatch` / `repository_dispatch` 不受限。
- **凡是要新增 PAT / GitHub App / 任何长期凭据，先写出「不引入它的话哪一步做不到」，并证明那一步无法改造成 `workflow_dispatch` 形态**。做不到这个论证就不要引入——长期凭据的维护成本会一直存在。
- **同一 run 内能闭合的步骤，不要拆成靠事件串联的两个工作流**。跨工作流串联的唯一硬需求，是「第二个工作流必须在不同 runner 上且由第一个的产物触发」，本仓库的发布链路不属于此类。
- **「已发布」的判据要选不可能被中间态污染的信号**。多步骤发布里，tag / 分支 / 提交都可能先于产物存在；只有最终产物（这里是带资产的 GitHub Release）才能当判据。
