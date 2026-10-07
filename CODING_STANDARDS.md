# 开发规范

## 通用

- 动手前先找参考实现：Loon/脚本类需求优先搜 GitHub（如 [chavyleung/scripts](https://github.com/chavyleung/scripts/)），按用户需求规划
- 面向最新版本写：代理软件配置先读最新文档，优先用新 API/新语法，不用被标记废弃的配置项
- 仓库公开：不硬编码节点、凭据等隐私信息
- 调用目标网站接口不做穷举式探测，除非用户允许

## 测试与沙箱

- 测试统一用 bun，入口在 `justfile`：`just test` 全部，`just run-test <关键字>` 按名过滤
- 网络行为与 rule 测试一律在沙箱 VM 内用真实数据跑（`just test-sandbox`），重点核对实际节点的出口/速度/延迟/变化；会创建 TUN、改路由的用例绝不落在宿主机，也不改动本机在用的规则
- 不在本机或容器内临时安装包，工具链一律走 mise 或镜像内置

## sing-box 与规则

- 底模只改 `config/sing-box/modules/`，改后跑 `just template-build` 重新生成 `template.json`
- 改底模/出站/规则集前先查配置文档与更新日志：https://sing-box.sagernet.org/configuration/ 、 https://sing-box.sagernet.org/changelog
- 从 raw.githubusercontent.com 更新文件时，同一文件距上次拉取至少间隔 5 分钟（CDN 缓存），遇到旧内容/404 先想到这一点
