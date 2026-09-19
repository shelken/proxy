# CONTEXT

## 词汇表

**开发机（dev machine）**
拉取本仓库、参与开发的机器。具备 Bun、mise、sing-box CLI、Lima 沙箱等完整工具链。`just` 命令面向此环境。

**设备（device）**
运行 sb-sync 的任意 arm Mac。唯一前置条件：sb-sync 二进制本体。不要求本仓库工作区、Bun、内核 CLI。

**sb-sync**
设备侧配置同步 CLI。Rust 编译的静态单二进制。职责：拉取通用底模 → 拉订阅/节点 → 本机装配 → 融合设备 local 覆盖 → 原子产出 singbox.json。

**底模（template）**
sing-box 配置的公共骨架：双入站、内网穿透、22 大分流策略组、route_exclude_address。来源三级：远程 main 分支 → 设备缓存 `~/.config/sing-box/template.json` → 二进制内嵌版。

**产物（output）**
装配完成的最终配置文件 `~/.config/sing-box/singbox.json`，SFM Local Profile 的来源。

**local 覆盖（local overlay）**
设备私有配置 `~/.config/sing-box/local.json`。覆盖 DNS、置顶路由规则等本机专属项，不进公开仓库。

**内核 CLI（kernel CLI）**
独立的 `sing-box` 命令行（与 SFM 内嵌的 libbox 同源不同形态）。仅存在于装了它的机器（如开发机经 mise 安装）。sb-sync 对它只有「有则校验、无则跳过」的可选依赖。

**SFM 面板（clash_api）**
SFM 进程暴露的本地 HTTP API（`127.0.0.1:9090`）。sb-sync 借它探测 SFM 在线状态与内核版本；无法远程触发配置校验（校验是 libbox 进程内库函数，外部不可达）。

**SFM 重载（reload）**
SFM 菜单栏开关 OFF→ON。`start()` 内部 `fetchProfile()` 从磁盘重读 profile 文件，等效重载。`scutil --nc stop/start` 只是隧道重连，不重读文件。

## 决策

- **单 URL 服务端装配已废除**：装配全部本地化（sb-sync），凭据零外泄。`endpoint.ts` 的 HTTP serve 外壳已删除
- **sb-sync 用 Rust**：静态单二进制（实测 ~2MB vs Bun 编译 60MB），无运行时依赖，网络层用 ureq（走系统 DNS 栈，避开 Bun fetch 的 CDN 边缘缓存 bug）
- **内核校验是可选依赖**：探测链 = `SING_BOX` 环境变量 → PATH 上的 sing-box → SFM 面板在线探测 → 全无则跳过校验。`.bak` 回滚保底。任何环境下 sync 都必须成功
- **不耦合仓库目录**：sb-sync 与定时任务均不引用本仓库工作区路径；仓库内 `.mise.toml` 仅服务开发机沙箱测试
