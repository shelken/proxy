# tag 守卫内的步骤躲过 CI，首次执行即发版

**日期**: 2026-09-23
**影响**: `release-sb-sync.yml` 里带 `if: startsWith(github.ref, 'refs/tags/')` 的步骤在 `workflow_dispatch` 下整段不执行，因而从不被 CI 验证。其中一处（改 `Cargo.toml` 版本却不改 `Cargo.lock`，随后跑 `--locked`）会让三个平台的构建**全部**失败，等于发版彻底堵死。该缺陷在 CI 全绿的状态下存在，只有打 tag 那一刻才暴露
**发现人**: 代码审查（独立 reviewer + 逐条实测复核），非 CI

## 问题

本仓库 `release-sb-sync.yml` 对只该在发版时发生的动作加了 tag 守卫，同时用 `workflow_dispatch` 支持手触发验证构建链路。两者叠加产生盲区：守卫内的步骤在手动触发时**根本不存在**，所以「手触发绿了」这个信号对它们零覆盖。

实例一（本次真炸的那个）：

```yaml
- name: Sync version with tag
  if: startsWith(github.ref, 'refs/tags/')      # ← workflow_dispatch 到不了这里
  run: |
    sed -i.bak "s/^version = \".*\"/version = \"${VERSION}\"/" Cargo.toml
    rm Cargo.toml.bak

- name: Test
  run: cargo test --release --locked --target ${{ matrix.target }}   # ← 这里才炸
```

`sed` 把 `Cargo.toml` 的版本改成 tag 版本（如 `0.3.5`），但 `Cargo.lock` 里 `name = "sb-sync"` 的版本仍是 `0.3.0`。两者不一致时 `--locked` 直接拒绝执行。

实例二（更早，同一模式）：manifest 合并最初只在 tag 上执行，`imagetools create` 的 digest 拼接与 GHCR 权限从未被跑过。当时的处置是给它也开一条 `workflow_dispatch` 通路（只推 `snapshot-<sha>`）——**恰好说明这个盲区是可消除的**，只是没被推广成规矩。

## 现象

在本机用 crate 的临时副本复刻（`Cargo.toml` 改为 `9.9.9`、`Cargo.lock` 保持 `0.3.0`）：

```console
$ cargo tree --locked --offline
error: cannot update the lock file /tmp/xxx/Cargo.lock because --locked was passed to prevent this
help: to generate the lock file without accessing the network, remove the --locked flag and use --offline instead.
exit=101
```

`cargo tree` 与 `cargo build`/`test` 走同一套锁文件校验，所以这就是 CI 会看到的报错。三个矩阵 job（macos-15 / ubuntu-24.04-arm / ubuntu-latest）会在「Test」步同时失败，产不出任何二进制。

实施修复动作后复测：

```console
$ cargo update --workspace
    Updating sb-sync v0.3.0 (...) -> v9.9.9
$ cargo tree --locked --offline
sb-sync v9.9.9 (...)
exit=0
```

## 根因

**错误假设**：「`workflow_dispatch` 能验证发版链路」。它验证的是**去掉守卫后的剩余部分**。带守卫的步骤在手动触发下是死代码，而检查这份工作流是否健康的唯一信号恰恰是手触发的结果。

**实际约束**：`--locked` 的语义是「锁文件必须与清单完全一致」，版本号也参与比对；而「单一事实来源 = git tag」的设计要求构建前改写清单版本——两者天然冲突，必须显式同步锁文件。这不是 Cargo 的怪癖，是设计使然。

**缺失的检查点**：没有任何机制枚举「哪些步骤只在 tag 上执行」。守卫被当成一个普通条件，而不是「CI 覆盖边界」的标记。

## 修复

`Sync version with tag` 末尾补一行同步锁文件：

```yaml
sed -i.bak "s/^version = \".*\"/version = \"${VERSION}\"/" Cargo.toml
rm Cargo.toml.bak
cargo update --workspace      # 只改 workspace 成员的版本条目，不动依赖
```

`--workspace` 而非裸 `cargo update`：后者会把全部依赖升到最新兼容版，让发版产物不可复现。实测输出只动 `sb-sync` 自己那一条。

## 预防

- **给工作流加 `if` 守卫时，同一次改动里必须回答「这段代码谁来跑」**。若答案只有「发版那一刻」，就必须额外提供一条能跑到它的通路（`workflow_dispatch` + 无害输出，如 `snapshot-<sha>`），否则它第一次执行就是生产事故。
- **审查工作流改动时，`grep -n 'github.ref' .github/workflows/*.yml` 列出全部守卫**，逐个确认守卫内的步骤是否已被任何常规触发覆盖。守卫是 CI 覆盖的边界，不是普通条件分支。
- **发版工作流的任何改动，在合并前用 `gh workflow run <wf> --ref <branch>` 手触发一次**。手触发的结论只对「未被守卫排除」的步骤有效——所以还要单独列出被排除的步骤，人工核对其逻辑。
- **验证锁文件一致性用 `cargo tree --locked` 或 `cargo build --locked`，不要用 `cargo metadata --no-deps`**：后者不做依赖解析，锁文件不一致时照样通过（本次实测，它在「坏」与「修好」两种状态下都给 exit=0，是无效验证）。

