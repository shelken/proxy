# 开发规范

## 通用

- 动手前先找参考实现：Loon 与脚本类需求先检索 GitHub，例如 [chavyleung/scripts](https://github.com/chavyleung/scripts/)
- 代理软件配置面向最新版本编写：改动底模、出站与规则集前先查阅[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog)，不使用标记废弃的配置项
- 仓库保持公开：不写入节点与凭据
- 调用目标网站接口限于用户允许的范围，不做穷举探测

## 沙箱与测试

- 测试优先走 `justfile` 入口；网络行为与 TUN/路由测试只在沙箱 VM 内跑，宿主机不建 TUN、不改路由表、不直接对 `config/sing-box/tests/` 跑全目录测试，不改动本机在用的规则
- 自动化沙箱回归保持合成上游；涉及实际出口、速度或延迟的改动，须在沙箱用真实数据验证变化（`just trace` 与 `just dns-observe` 需 `.env` 及已提交触发 CI 构建的产物）
- 工具走 mise，不在本地、VM 或容器临时安装包

## sing-box 与规则

- 三份底模 `template.json`、`template-ios.json`、`template-router.json` 是生成产物，不手改，改完输入后用 `just template-build` 重建
- `raw.githubusercontent.com` 同一文件至少间隔 5 分钟再拉取，CDN 存在缓存，遇到旧内容或 404 先核实缓存
