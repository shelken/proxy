# 手写样例测不出日志解析边界，需真实抓取序列回归

**日期**: 2026-09-29
**影响**: PR #56 的中间提交声称「不丢无请求号的日志」，单测全绿，但实机上 `dns: match` 行仍被整条丢弃，内核 DNS 判定阶段整体落空；直到拿真机日志流对照才发现
**发现人**: 终审时对真机（内核 1.14.2）跑 `sb-sync trace` 对照，两个目标域名的 DNS 判定都报「未捕获」

## 问题

`absorb_line` 的单测全部用手写日志行，其中无 id 的 `dns: match` 样例都带了 `domain_in_line` 能认出的域名。真实内核里该行只带 `query_type` / `domain_suffix`：

```console
$ # 实机 /logs?level=debug 捕获（无请求号，match 行无裸域名）
dns: exchange photo.int.ooooo.space. IN A
dns: match[0] query_type=A domain_suffix=.int.ooooo.space => predefined(NOERROR,*. 3600 IN A 192.168.69.46)
```

`domain_in_line` 只解析嗅探行与 exchange/lookup 行，对 match 行返回 `None`，于是 match 行整条丢弃。单测的样例恰好集体绕开了这种形态。

## 现象

```console
$ cargo test
test result: ok. 84 passed; 0 failed

$ sb-sync trace photo.int.ooooo.space
⚠ 内核 DNS 判定   未捕获到匹配规则（可能命中缓存或 final）
```

修复后同一命令输出 `✓ dns: match[0] ... => predefined(...)`。

## 根因

**错误假设**：手写样例覆盖了输入空间。实际约束：日志行带不带域名由内核打点决定，与测试怎么写无关；解析函数对某一真实形态（带 `domain_suffix` 的无 id 决策行）的边界洞，只有在样例包含该形态时才暴露。

**缺失的检查点**：声称「X 不再丢失」类修复前，没有用真实数据流做端到端对照；样例来源全是脑补而非 `/logs?level=debug` 抓取。

## 修复

- 同一查询里 exchange 行在前、match 行在后且相邻，把 exchange/exchanged 行确立的域名记入 `KernelDecisions.recent_dns_domain`，回填给相邻无 id 决策行（已知上限：并发无前缀查询交错时可能误归属，已注释说明）
- 用实机捕获的行序列做成回归测试（`absorb_line_backfills_recent_dns_domain`），并注入缺陷确认测试会红
- 修复前后对同一真机跑对照探测，以输出变化作为修复依据

## 预防

- 解析内核日志的代码，回归测试必须含真实抓取的行序列，样例上方注明抓取来源与抓取方式
- 「X 不再丢失/修复」类声明，以真实数据流的端到端输出为验收依据，单测绿不构成声明依据
- 新增解析分支前，先检查真实输入里该行的完整字段形态（有哪些行不带裸域名），再写测试
