# sb-sync 放弃设备侧直写 SFM，改走加密订阅 URL

旧交付链路由 `sb-sync sync` 直接读写 SFM 的 Group Container 与 `settings.db`，被 macOS 27 的跨沙盒权限彻底阻断（读数据库报 `authorization denied`），且不存在无需完全磁盘访问权限的合法修复通道。改为利用 SFM 原生的 Remote Profile 订阅机制：客户端把订阅与节点加密成一条 URL，服务端解密后装配并调用官方 `sing-box merge` 响应标准配置 JSON，凭据全程不经第三方

## Consequences

- 服务端必须常驻并持有私钥，客户端只持有公钥。公钥非机密，经 `/pubkey` 明文获取即可，省掉手工同步密钥材料
- 设备侧不再需要完全磁盘访问权限，也不再依赖 SFM 内部文件布局（该布局随 SFM 版本变动）
- 失败模式从「写文件被拒」变为「HTTP 不可达或解密失败」，诊断入口转为服务端日志
- 合并交给官方 CLI，服务端不自研合并算法。输入按 `01-overlay` / `02-base` 命名，字典序决定标量覆盖与数组拼接
