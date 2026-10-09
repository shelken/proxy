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

- `template.json` 由 `modules/` 经官方 `sing-box merge` 生成：只改 `modules/`，再 `just template-build`
- `modules/` 文件名前缀决定合并顺序，也就决定 `route.rules` 与 `outbounds` 的数组顺序：`00`-`39` 全局与核心（入站、DNS、
  路由全局属性、前置动作、守卫、拦截、解析、核心出站组），`41`-`63` 自有清单（`custom/`）服务，`65`-`69` 外部清单服务，
  `71`-`79` 默认直连的分组，`80` 兜底规则，`90` 收尾。每个服务一个文件（路由规则 + rule_set + 出站组），号段留空便于插队。
  新增服务 = 新建一个文件 + 在 `index.yaml` 登记 rule_set，不用再改别的文件
- 服务顺序的两条策略：自有清单默认排在外部清单（`geosite:` / `geoip:`）之前，宽泛的上游清单会抢走自有清单的域名；
  出站组默认 `direct` 的服务模块排到服务号段最后，避免默认直连的组抢占代理流量。两者都靠文件名前缀实现，理由见
  `docs/adr/0007`
- 改底模、出站、规则集前先查[配置文档](https://sing-box.sagernet.org/configuration/)与 [changelog](https://sing-box.sagernet.org/changelog)
- raw.githubusercontent.com 同一文件至少隔 5 分钟再拉（CDN 缓存）；见到旧内容或 404 先想到它
- `38-resolve.json` 里有一条 `action: resolve` 规则，让代理流量在本机按 v4 解析后再交给节点。它的排除清单必须覆盖所有走 `direct` 的规则集（漏一个，该组流量就会先被远端解析器解析成海外 IP 再直连）；新增直连规则集时同步它，`config/sing-box/tests/template.test.ts` 会拦住漏项
