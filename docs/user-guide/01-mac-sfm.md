# Mac + SFM 使用指南

在 macOS 上用 [SFM](https://sing-box.sagernet.org/clients/apple/)（sing-box for Mac）承载 sb-sync
产出的配置。前置：已按 [00-cli-sync.md](./00-cli-sync.md) 完成 sb-sync 安装与 sync。

本指南基于 SFM 1.14.1 实测。以下 `$SFM_DIR` 指 SFM 的数据目录
（TestFlight 版为 `~/Library/Group Containers/P8XK3KHB48.io.nekohasekai.sfamt`，
App Store 版为 `~/Library/Group Containers/group.io.nekohasekai.sfm`）。

## 一次性导入

SFM 的 profile 是**拷贝式**：导入后 SFM 使用自己的副本，后续 sync 更新产物后需要重新导入并重载。

1. sb-sync sync 产出 `~/.config/sing-box/singbox.json`
2. 打开 SFM → `Profiles` → `New Profile` → 类型选 `Local`，命名（如 `singbox`）
3. 编辑该 profile，把产物文件内容全量粘贴保存；或用命令拷贝到 profile 文件
4. 主界面选中该 profile → 开关 OFF→ON 启动

拷贝式同步（示例：目标 profile 的文件路径可在 `$SFM_DIR/configs/` 下按修改时间辨认）：

```bash
cp ~/.config/sing-box/singbox.json "$SFM_DIR/configs/config_N.json"
```

## 日常更新循环

配置变更（订阅节点变化、底模更新、local 覆盖调整）生效三步：

```bash
sb-sync sync                    # 1. 更新产物
cp ~/.config/sing-box/singbox.json "$SFM_DIR/configs/config_N.json"   # 2. 覆盖 profile
```

3. SFM 菜单栏开关 OFF→ON 重载

sb-sync sync 检测到 SFM 面板在线时会打印重载提示。

## 面板与节点切换

- 菜单栏图标 → `Open Dashboard`（或浏览器访问 `http://127.0.0.1:9090/ui`）打开 Web 面板
- `Proxies` 页：9 大策略组，点击组内节点即切换出口；`openai` 组等专用组独立切换
- `Connections` 页：实时连接与命中规则排查

## Remote Profile（可选，多设备场景）

SFM 原生支持 remote profile（`Profiles` → `New Profile` → 类型 `Remote`），填 URL 后按间隔自动拉取。
适合已有 HTTP 端点提供配置的场景；单机用户用 Local Profile 更简单，不需要自建端点。

## 已知行为与坑

- **TUN 网段被 SFM 改写**：产物写 `198.18.0.1/30`，SFM 导入后实际以 `172.19.0.1/30` 运行（客户端行为）。
  由此产生过一个真实故障：系统 DNS 解析器若落在此网段会被 `route_exclude_address` 排除逻辑误伤，
  现象为 DNS 解析链断裂。sb-sync doctor 会检出该问题（输出「系统解析器落在排除段」告警）
- **Local Profile 无自动更新**：SFM 对 Local Profile 不做任何自动拉取，更新全靠上面「日常更新循环」
- **profile 内容漂移**：SFM 保存 profile 时会重写 `experimental` 段（如补 `external_ui`），
  属正常现象，不影响与产物的一致性比对（比对时排除该段）

## 验证闭环

```bash
sb-sync doctor
```

预期：配置校验通过、DNS 解析链成功、直连/代理/CDN 全部 HTTP 2xx。若 SFM 已启动而 doctor 的
代理站点失败，先确认菜单栏开关已 ON、面板 Proxies 页各策略组已选中可用节点。
