# CONTEXT

## 词汇表

**开发机**
拉取本仓库、参与开发的机器，具备 Bun、mise、sing-box CLI、Lima 沙箱等完整工具链，`just` 命令面向此环境

**设备**
运行 sbtools 的 arm Mac，唯一前置条件为 sbtools 二进制，不要求本仓库工作区、Bun 或内核 CLI
**sbtools**
双形态静态单二进制；客户端形态 `encode` 读取本机 YAML，用服务端公钥加密后产出订阅 URL；服务端形态 `server` 解密载荷、装配节点、调用官方 sing-box CLI 合并后响应配置 JSON；另有 `trace` 诊断子命令与 `keygen` 密钥生成

**workspace 根清单**
仓库根的 Cargo workspace 清单，无版本号；crate 在 `scripts/sbtools-rs`，版本真源是该 crate 的 `Cargo.toml`；根清单必须留在仓库根，满足 release-plz 的 `git_only` 模式定位要求

**底模**
sing-box 配置的公共骨架，包含双入站、内网穿透、分流策略组与 route_exclude_address；服务端默认使用编译期内嵌版；客户端在 YAML 配 `template_url` 时改用下载的远端底模

**DNS 出口**
访问真实 DNS 上游所使用的网络路径，可独立于应用的业务出口选择

**业务出口**
应用连接远端服务所使用的网络路径，决定服务看到的来源 IP 与地区

**订阅 URL**
客户端 `encode` 的产物；密文载荷为本机 YAML 配置，粘贴进 SFM Remote Profile 后由 SFM 按间隔拉取；配置变更需重新 `encode` 并覆盖该 profile 内的 URL

**服务端公钥**
`GET /pubkey` 的返回值，由服务端私钥推导，非机密，客户端 `encode` 自动获取，无需手工配置

**SFM Remote Profile**
SFM 原生订阅机制，填入订阅 URL 后由 SFM 按间隔自动拉取，不再需要客户端写本地文件或数据库

**服务端**
无状态容器形态，负责解密客户端载荷、装配节点、调用官方 sing-box CLI 合并并响应配置 JSON，仅依赖 `SERVER_PRIVATE_KEY` 环境变量

**内核 CLI**
独立的 `sing-box` 命令行，服务端镜像内自带固定版本，开发机经 mise 安装

## 决策

- **交付走 SFM Remote Profile**：客户端直写 SFM 内部数据库受 macOS 跨沙盒权限限制，改为产出订阅 URL 由 SFM 自动拉取
- **客户端与服务端分离**：客户端仅持有服务端公钥，私钥仅存服务端，订阅凭据加密传输
- **合并采用官方 CLI**：不自研合并算法，输入按字典序确定优先级
- **sbtools 采用 Rust 实现**：静态单二进制，无运行时依赖
- **远程底模严格校验**：仅允许 https、拒绝内网地址、限制大小并拒绝本地路径引用
- **严格 lint 与静态检查**：代码禁止 unsafe 与 panic，编译校验由 CI 在远程执行
- **不耦合仓库目录**：sbtools 不引用本仓库路径，`.mise.toml` 仅服务开发测试
- **Cargo workspace 置于仓库根**：release-plz 自动版本推导要求清单与 `.git` 同目录，架构规范见 `RELEASE.md`
