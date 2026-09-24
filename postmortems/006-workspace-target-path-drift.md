# workspace 上移后 target 目录位置未同步，发版复制到过期二进制

**日期**: 2026-09-24
**影响**: `release-sb-sync` 的三个平台构建 job 在版本断言步全部失败，v0.5.3 发不出去；失败信号是「二进制版本 0.5.2 ≠ 清单 0.5.3」，指向的问题方向与实际根因完全不符
**发现人**: 日志比对（两次失败运行的 ELF BuildID 完全一致，暴露产物来自缓存而非本次构建）

## 问题

为修 release-plz 的 `git_only` 仓库定位缺陷，把 Cargo workspace 上移到仓库根。迁移只改了 `--manifest-path` 与文件名引用，**没改 cargo 输出目录的位置约定**：workspace 化后 `target/` 属于 workspace 根，不再位于 crate 子目录。

工作流仍在 crate 工作目录下执行 `cp target/<triple>/release/sb-sync ../../<artifact>`。该路径此时落在 `scripts/sb-sync-rs/target/`，而缓存（`actions/cache` 里同时锚了 `scripts/sb-sync-rs/target`）恰好把迁移前的旧目录整棵恢复回来，里面躺着上一版二进制。`cp` 因文件**存在**而成功，于是发出去的产物是旧版本的。

## 现象

构建日志一切正常，编译出的版本也是对的：

```console
$ # 日志（job: binary (sb-sync-x86_64-unknown-linux-musl)）
   Compiling sb-sync v0.5.3 (/home/runner/work/proxy/proxy/scripts/sb-sync-rs)
    Finished `release` profile [optimized] target(s) in 18.19s
```

紧接着断言失败，报的却是旧版本：

```console
$ file "sb-sync-x86_64-unknown-linux-musl"
sb-sync-x86_64-unknown-linux-musl: ELF 64-bit LSB pie executable, x86-64, … BuildID[sha1]=f6140af0…, stripped
二进制版本与清单不一致: sb-sync 0.5.2
```

关键判据：两次不同 commit（`491e4ed`、`5c27c1e`）的运行报出**完全相同的 BuildID**。若产物来自本次编译，两次构建不可能同 ID——只能来自同一份被缓存恢复的旧文件。

## 根因

**错误假设**：「target 目录在 crate 目录下」是 cargo 的固有行为。实际是 workspace 根共享 target；`cargo build` 在哪个子目录启动不影响输出位置。

**缺失的检查点**：迁移清单与锁文件路径时，没有一并枚举「依赖 cargo 输出目录位置」的引用点（`cp` 源路径两处、`actions/cache` 的 `path` 三处、`.gitignore` 一处）。

**放大器**：缓存路径仍锚旧目录，使错误的 `cp` 源路径**存在且非空**，把「路径写错」从「cp 报错」降级为「静默复制错文件」。

## 修复

`cp` 源与全部缓存路径改指仓库根 target：

```diff
-          cp "target/${{ matrix.target }}/release/sb-sync" "../../${{ matrix.artifact }}"
+          cp "../../target/${{ matrix.target }}/release/sb-sync" "../../${{ matrix.artifact }}"
```

```diff
           path: |
             ~/.cargo/registry
             ~/.cargo/git
-            scripts/sb-sync-rs/target
+            target
```

`.gitignore` 改为 `/target/`。修复后 `release-sb-sync` 全绿，v0.5.3 的三平台二进制、双架构镜像与 Release 正常产出。

## 预防

- **改 Cargo 布局（workspace 上移 / 新增成员 / 改 `target-dir`）后，必须 grep 一遍 `target/` 的全部引用点**：工作流里的 `cp` 与 `actions/cache` 的 `path`、`.gitignore`、`Dockerfile` 的 COPY 源。只改 `--manifest-path` 不算迁移完成。
- **`cp` 之后的产物必须自证版本**：本仓库靠 `Assert binary version` 拦住，这条断言不能删。它把「静默发旧版」变成硬失败。
- **缓存键或路径变更后，下一次发版必须核对产物指纹（BuildID / sha256）与上次不同**。两次独立构建报出同一指纹，等于自证产物没被重新生成。
- **缓存 `path` 指向的目录要与构建实际输出目录一致**；指向过期目录不会报错，只会让过期产物复活。
