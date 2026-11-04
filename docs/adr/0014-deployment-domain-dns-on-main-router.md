# 部署域的静态应答交给主路由，路由侧不再自带

**日期**：2026-11-04

底模原本给 `ooooo.space` 配了两条 predefined 规则：一条给该域的子域一个固定内网入口地址，一条让其余查询由本机空应答。这两条只服务 mac / iOS，路由侧本来就经由 `MyDirect-dns → dns-lan` 问主路由，所以路由变体弃用它们，答案改由主路由 dnsmasq 给。

## Context

- 该域已登记在 `config/rules/custom/MyDirect.yaml`，在路由侧会落到 `dns-lan`（主路由）。静态应答只是把结果钉在底模里，代价是同一个事实在仓库与主路由两处维护
- 弃用依赖一个外部前提：主路由 dnsmasq 必须对这个域有记录

## Decision

路由变体用空集弃用底模那份部署域静态应答（接口形状见 [0013](0013-capability-files-instead-of-variant-copies.md)），设备看到的答案由主路由给；mac / iOS 继续用底模那两条。

## Consequences

- 前提实测成立：在局域网内 `dig @<主路由> cpa.int.ooooo.space A` 返回 `192.168.69.46`，`int.ooooo.space` 无应答，与那两条规则的效果一致
- 回退：把 `modules-router/10-dns-deployment.json` 的内容换成 `modules/10-dns-deployment.json` 的两条规则，`route.rules` 不动
- 设备上看到的答案从此取决于主路由的记录，改内网入口要改主路由，不再需要重铸订阅 URL
