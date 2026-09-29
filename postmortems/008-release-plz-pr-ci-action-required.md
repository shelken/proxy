# release-plz 版本 PR 的 CI 卡在 action_required

**日期**: 2026-09-29
**影响**: v0.5.4 发布 PR 无任何 CI 结果（`no checks`），无法按 RELEASE.md「核对 CI 结果再 Merge」的流程放行
**发现人**: 发布前核对 PR #49 检查状态时

## 问题

release-plz 按流程开了版本 PR #49（0.5.3 → 0.5.4）。PR 的 checks 显示 `no checks`，工作流运行列出了三条却全部停在 `action_required`，不排队、不执行。

## 现象

```console
$ gh pr checks 49
（no checks）

$ gh run list --branch release-plz-2026-09-27T10-28-46Z --limit 3
completed action_required chore: release v0.5.4
```

批准后立即进入队列并跑完（`fmt + clippy + test` 1m42s、`docker build` 59s，全绿）：

```console
$ gh api repos/<owner>/<repo>/actions/runs/<run-id>/approve -X POST
{}
```

## 根因

**实际约束**：用 `GITHUB_TOKEN` 创建的 PR，GitHub 不自动触发其工作流（防递归触发设计），运行记录停在 `action_required` 等人工批准。而 RELEASE.md 明确发布链路只用仓库自带 `GITHUB_TOKEN`，不用 PAT 或 App，所以每个版本 PR 都会走到这一步。

## 修复

取最新 run 的 id 手动批准，CI 随即正常执行：

```console
$ gh run list --branch <release-plz-分支> --limit 1 --json databaseId --jq '.[0].databaseId'
$ gh api repos/<owner>/<repo>/actions/runs/<run-id>/approve -X POST
```

## 预防

- 版本 PR 的放行清单加一步：`gh pr checks <n>` 显示 `no checks` 时，先按上面两条命令批准最新 run，等全绿再 Merge
- 该步骤对每个 release-plz 版本 PR 都会出现，属于常规操作而非故障，不修改 GITHUB_TOKEN 方案
