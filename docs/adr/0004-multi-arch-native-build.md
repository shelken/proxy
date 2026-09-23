# 多架构镜像按平台原生构建后合并 manifest

集群是混合架构：控制平面跑在 Mac 上的 Lima VM（arm64），worker 是 Intel PVE VM（amd64），而 `sb-sync-server` 的部署清单不含任何节点亲和约束，Pod 可落到任一节点。镜像必须同时支持两种架构。采用每平台一个 job、在对应原生 runner 上构建后按 digest 合并 manifest 的方式，不使用 QEMU 模拟跨架构编译

## Consequences

- 避免模拟执行带来的构建时长与偶发失败，也避免在交叉编译环境里调 musl 链接器
- 二进制与镜像架构天然对齐，不存在向镜像中拷入异架构二进制的风险
- 镜像构建不再承担 Rust 编译验证职责，编译校验由独立 CI 工作流承担
- 新增架构只需在矩阵里加一项，无需改动构建逻辑
