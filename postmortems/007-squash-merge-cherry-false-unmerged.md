# squash 合并后 git cherry 误报未合并

**日期**: 2026-09-29
**影响**: 清理已合并 PR 时两度误判（`revert-internal-static-answer`、`shelken/server-delivery`），把内容已在 main 的分支当成「有未合并内容」不敢删；方向反了还会误删真有内容的分支
**发现人**: 阶段收尾清理 worktree 时，`git cherry` 结果与 GitHub MERGED 状态矛盾

## 问题

清理已合并 PR 的本地分支。`git merge-base --is-ancestor` 与 `git cherry` 都判「未合并」，但 GitHub 上 PR 是 MERGED。两个案例：

- PR #60（revert 内部域委托）标记 MERGED，`git cherry origin/main revert-internal-static-answer` 报 2 个未合并补丁
- server-delivery 分支 9 个提交全部报未合并，但 main 的 `server.rs` 文件头与分支逐字一致，`template_url`、公钥自动获取等特性全在 main

## 现象

PR #60 是 squash 合并。取分支尖端与 squash 提交做树对比：

```console
$ git diff e45c037 f70233f --stat
（空输出）
```

树完全一致，内容一分不差在 main。时间线：revert 提交 01:57 → 压缩提交 02:24 → squash 合并 02:42，squash 抓走的正是分支尖端。

同时两点 diff 显示 `main.rs -120`、`server.rs -87` 等大段「删除」，进一步误导为「main 会丢内容」。

## 根因

**错误假设**：「补丁指纹（patch-id）对得上才算已合并」。实际约束：squash 把多个提交压成一个新提交，原单提交的 patch-id 与合并产物永远对不上，`git cherry` 必然误报。

**放大器**：分支基线落后于 main 时，两点 diff（`origin/main..branch`）把「main 多出来的内容」反向显示成分支的删除，看起来像合并会丢功能。

## 修复

用树对比裁决，不认补丁指纹：

```console
$ git log --oneline origin/main | grep '(#60)'      # 找到 squash 合并提交
$ git diff <branch-tip> <squash-commit> --stat      # 空输出 = 内容完全在 main
```

两个分支确认后均已删除，reflog 保留 90 天兜底。

## 预防

- 清理已合并 PR 的分支前，判据改为：找到 PR 的合并提交（`git log --merges origin/main` 或带 `(#N)` 后缀的 squash 提交），`git diff <branch-tip> <merge-commit>` 为空才删
- `git cherry` 只在 merge commit（非 squash）工作流下可信
- 两点 diff 出现大段删除时，先怀疑基线落后：与合并提交同期对比（如 `git diff <branch-tip> <squash-commit>`），不要直接读成「会丢内容」
