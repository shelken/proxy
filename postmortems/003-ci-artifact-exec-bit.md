# CI artifact 不保留可执行位导致容器启动失败

**日期**: 2026-09-23
**影响**: 镜像改为多架构时，`COPY` 预编译二进制的 Dockerfile 若不加 `chmod`，容器启动即 127。此缺陷在引入冒烟步骤前不会暴露——原 docker job 只 `push-by-digest`，从不真正运行镜像，坏镜像会直接发版并在部署时才炸
**发现人**: 本次新增的冒烟步骤（构建后起容器验 `/healthz`）

## 问题

`sb-sync-server` 镜像从「容器内编译」改为「COPY 预编译二进制」后，构建、推送、manifest 合并全部成功，但容器一起就退：

```
docker: Error response from daemon: failed to create task for container:
failed to create shim task: OCI runtime create failed: runc create failed:
unable to start container process: error during container init:
exec: "sb-sync": executable file not found in $PATH
```

`COPY` 成功了、文件也在 `/usr/local/bin/sb-sync`，但权限位是 `0644`。

## 根因

**GitHub Actions 的 artifact 上传/下载不保留文件权限**（官方已知行为，与 tar/zip 打包实现有关）。发布工作流的链路是：

```
binaries job:  cargo build → cp target/release/sb-sync ./<artifact>
               → actions/upload-artifact
docker job:    actions/download-artifact → mv → COPY sb-sync /usr/local/bin/
```

`actions/upload-artifact` 存的是 zip，zip 不携带 Unix 权限位；下载后文件权限由 umask 决定，得到 `0644`。Dockerfile 的 `COPY` **原样保留**源文件权限（这正是它与 `ADD` 加 tar 自动解包的区别），于是镜像里的二进制不可执行。

`COPY --from=singbox` 那一层没问题：它从镜像层拷贝，权限位随层一起保留（`sing-box` 是 `0755`）。错的是跨 artifact 传递的那一份。**同一条 Dockerfile 里两种 `COPY` 语义不同**——这是根因的关键，前者可信，后者不可信。

## 修复

```dockerfile
COPY sb-sync /usr/local/bin/sb-sync
RUN chmod +x /usr/local/bin/sb-sync
```

修复的验证由每平台 job 内的冒烟步骤承担：build 时 `load: true` 一份到本机（runner 就是该平台原生架构），起容器、等 `/healthz`、校验 `/pubkey` 是 64 位十六进制、`docker exec ... sb-sync version` 确认镜像内二进制可执行。冒烟过了才推 digest。

## 预防

- **`COPY` 从构建上下文进来的可执行文件，一律跟一条 `chmod +x`**。本项目里这条适用于任何跨 CI job 传递的二进制（artifact、cache、actions/upload-download-artifact 全家）。
- **新增「构建产物」类 job 时，必须带一步真运行**：只验证「构建成功」与「推送成功」的 job 会放过运行期缺陷。判据是「这个产物被谁以什么方式执行」——镜像是 `docker run`，二进制是直接执行，二者都要在 CI 里真跑一次。
- 发布链路中「只在 tag 上第一次执行」的分支（manifest 合并、镜像运行）必须提供 `workflow_dispatch` 通路，否则它第一次运行就是发版那一刻。本 PR 为此把多架构镜像链路开到了手触发（只推 `snapshot-<sha>`）。
