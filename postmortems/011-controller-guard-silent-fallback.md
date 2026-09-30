# controller 守卫静默回退,只读顶层漏掉 overlay 形态

**日期**: 2026-09-30
**影响**: sbtools 的 logs/trace/config 三个子命令,配置了非回环 clash api controller 时静默回退缺省口 127.0.0.1:9090,真连上了本机真机 SFM 并输出其运行时数据;config 另漏读 overlay 形态的 controller,客户端 YAML 场景下守卫完全失效
**发现人**: 协调者对 PR3 Lane 7 的审计,与收尾 PR 的 release 冒烟

## 问题

logs/trace/config 的 controller 解析链,对「配置了 controller 但非回环」的情形做了静默回退:丢弃配置值,改连缺省口。缺省口上恰有真机 SFM 常驻,观测数据张冠李戴,且把真机流量摘要带进了本不该出现的输出。config 更叠加一层:controller 只从配置顶层读取,而客户端 YAML 的 clash_api 只会出现在 overlay 字符串里,该形态下守卫从未生效

## 现象

```sh
# fixture: overlay 内写 external_controller: 192.0.2.5:19090
HOME=<fakehome> sbtools config
# 输出含 ✓ SFM 运行时 (clash api 127.0.0.1:9090) ← 真连上了无关内核
```

logs/trace 侧同理:守卫夹具 192.0.2.5:19090 被丢弃,实际跟踪的是缺省口

## 根因

错误假设有二:一是把「配置值不合法」当成「当作没配」处理,两种语义被合并成同一条回退路径;二是假设 controller 只出现在配置顶层,没有覆盖客户端 YAML 的 overlay 形态。守卫写了,但拒绝动作是 None 而非报错,调用方拿 None 就回退,守卫等于没设

## 修复

- logs/trace:配置了非回环 controller 显式报错退出(拒绝并提示),仅「配置源完全没有 controller」才允许缺省口,`resolve_logs_controller` 返回 Result 区分两种情形
- config:controller 发现顺序对齐 logs(顶层 → overlay),非回环时提示并跳过运行时摘要,不挡本地脱敏主输出(见 PR #78)
- `clashapi::is_loopback` 提取为公共谓词,三命令共用同一判定

## 预防

- 写守卫时先回答:拒绝后走哪条路?答案若是「回退默认值」,守卫就是装饰品,必须改为显式报错或显式跳过并提示
- 回环守卫类检查的测试夹具必须覆盖 overlay 形态(客户端 YAML 的常态),不能只测顶层 JSON
- 涉及「连上本机服务」的命令,冒烟时确认缺省口上有没有真机在跑,别让测试输出吃进真数据
