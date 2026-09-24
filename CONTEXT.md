# CONTEXT

## 词汇表

**开发机（dev machine）**
拉取本仓库、参与开发的机器。具备 Bun、mise、sing-box CLI、Lima 沙箱等完整工具链。`just` 命令面向此环境。

**设备（device）**
运行 sb-sync 的任意 arm Mac。唯一前置条件：sb-sync 二进制本体。不要求本仓库工作区、Bun、内核 CLI。

**sb-sync**
双形态静态单二进制。客户端形态 `encode`：读本机 YAML，用服务端公钥加密后产出订阅 URL；服务端形态 `server`：解密载荷、装配节点、调用官方 sing-box CLI 合并后响应配置 JSON。另有 `trace` 诊断子命令与 `keygen` 密钥生成。

**workspace 根清单（root Cargo.toml）**
仓库根的 Cargo workspace 清单，无版本号。crate 在 `scripts/sb-sync-rs`，版本真源是该 crate 的 `Cargo.toml`。根清单必须留在仓库根：release-plz 的 `git_only` 模式在清单所在目录打开 Git 仓库。

**底模（template）**
sing-box 配置的公共骨架：双入站、内网穿透、分流策略组与 route_exclude_address。服务端默认使用编译期内嵌版；客户端在 YAML 配 `template_url` 时改用下载的远端底模（仅 https，严格校验）。

**订阅 URL（subscription URL）**
客户端 `encode` 的产物。密文载荷就是本机 YAML 配置（ECIES，`/sub?d=`），粘贴进 SFM Remote Profile 后由 SFM 按间隔拉取；配置一变就要重新 `encode` 并覆盖该 profile 里的 URL（每次密文都不同）。

**服务端公钥（server public key）**
`GET /pubkey` 的返回值，由服务端私钥推导。非机密，客户端 `encode` 自动获取，无需手工配置。

**SFM Remote Profile**
SFM 原生订阅机制。填入订阅 URL 后由 SFM 按间隔自动拉取，不再需要客户端写本地文件或数据库。

**服务端（sb-sync server）**
无状态容器形态：解密客户端载荷、装配节点、调用官方 sing-box CLI 合并、响应配置 JSON。只依赖 `SERVER_PRIVATE_KEY` 环境变量。

**内核 CLI（kernel CLI）**
独立的 `sing-box` 命令行。服务端镜像内自带固定版本（升级需重跑合并语义验证）；开发机经 mise 安装。

## 决策

- **交付走 SFM Remote Profile**：客户端直写 SFM Group Container 的 `settings.db` 与 profile 文件被 macOS 跨沙盒权限阻断且无合法修复通道，改为产出订阅 URL 由 SFM 自行拉取
- **客户端与服务端分离**：客户端只持有服务端公钥（经 `/pubkey` 自动获取），私钥只在服务端；订阅凭据加密后传输
- **合并用官方 CLI**：不实现合并算法，输入按 `00-direct` / `01-overlay` / `02-base` 命名，路径字典序决定优先级（标量取先者、数组按序拼接）
- **sb-sync 用 Rust**：静态单二进制，无运行时依赖
- **远程底模必须严格校验**：载荷公钥公开，任何能访问 `/sub` 的人都能指定 `template_url`，故仅 https、拒内网地址、限 1MB、拒路径引用字段
- **零警告 + 严格 lint**：规则写在 crate 属性（`forbid(unsafe_code)`、`deny(warnings)`、`deny(clippy::all, pedantic)`，生产代码禁 `unwrap`/`expect`/`panic`），编译校验全部由 `.github/workflows/ci-sb-sync.yml` 在远程执行
- **不耦合仓库目录**：sb-sync 不引用本仓库工作区路径；仓库内 `.mise.toml` 仅服务开发机沙箱测试
- **Cargo workspace 置于仓库根**：release-plz 自动版本推导要求清单与 `.git` 同目录，故根清单 + 根 `Cargo.lock` + 根 `target/`（见 `RELEASE.md`）
