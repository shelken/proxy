# 开发规范

## 通用

- 动手前先找参考实现：Loon/脚本类需求先搜 GitHub（如 [chavyleung/scripts](https://github.com/chavyleung/scripts/)）
- 代理软件配置面向最新版本写：先读最新文档，不用被标记废弃的配置项
- 仓库公开：不写入节点、凭据
- 调用目标网站接口限于用户允许的范围，不做穷举探测

## 沙箱

- 网络行为与规则测试只在沙箱 VM 内跑
- 用真实数据验证，重点看实际节点与规则的出口、速度、延迟变化
- 宿主机不建 TUN、不改路由表，不改动本机在用的规则
- 测试用 bun，入口见 `justfile`
- 工具走 mise，不在本地或容器临时安装包

## sing-box 与规则

- `template.json` 由 `modules/` 生成：只改 `modules/`，再 `just template-build`
- 改底模、出站、规则集前先查[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog)
- raw.githubusercontent.com 同一文件至少隔 5 分钟再拉（CDN 缓存）；见到旧内容或 404 先想到它
