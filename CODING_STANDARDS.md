# CODING_STANDARDS

核心节始终适用；分支节按节首触发词选读。

## 核心（始终适用）

- 仓库公开：改动不得携带隐私数据
- 用 mise 既有工具链，不在本地或容器临时安装包
- 改代理配置前先读该软件的最新官方文档，弃用项一律改写为现行替代

## Loon 插件（改 `config/loon/` 时读）

- 动手前先找参考实现再规划（同类脚本库：[chavyleung/scripts](https://github.com/chavyleung/scripts/)）
- 目标网站接口调用限于用户允许的范围，不做穷举探测

## sing-box 底模（改 `config/sing-box/` 时读）

- 官方[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog) 是写法真源
- template.json 变更必须用沙箱真实数据验证，重点看实际节点与规则的出口、速度、延迟变化

## 沙箱与规则测试（跑网络行为测试或编译规则时读）

- 网络行为测试只在沙箱 VM 内跑（`just test-sandbox`），宿主机直跑会建 TUN、改写路由表；不碰宿主机在用的规则配置
- 拉上游规则清单时注意 raw.githubusercontent.com 同一文件 5 分钟缓存

## 发布（发版时读）

- 流程见 `RELEASE.md`
