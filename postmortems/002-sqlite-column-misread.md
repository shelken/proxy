# sqlite 列错位读取与 BLOB 误读导致错误结论

**日期**: 2026-09-19
**影响**: 向用户断言「当前激活 profile 是 test-local」，实际是 singbox；用户截图纠正。若基于该结论做自动化（如覆盖错误 profile 文件），会写坏用户在用配置
**发现人**: 用户

## 问题

为确认 SFM 当前激活的 profile，直接用 sqlite3 查 `settings.db`。两处错误叠加：
`SELECT id, IFNULL(remark,''), type, ...` 引用了 schema 中不存在的列名 `remark`（实际第 2 列是 `name`），SQLite 静默返回错位结果；把 `preferences` 表 BLOB 的 `length(data)`（字节数 2/6）当成了解码后的值。两层错误互相「印证」，得出 selected=2 (test-local) 的错误结论。

## 现象

```bash
sqlite3 settings.db "SELECT id, IFNULL(remark,''), type FROM profiles"
# 返回 2|test-local|1 被解读为 type=1=remote 且 selected → 错
sqlite3 settings.db "SELECT name, length(data) FROM preferences"
# selected_profile_id|2 ← 这是 BLOB 字节数, 不是值
```

真实数据（`quote()` 解码后）：`selected_profile_id` = BLOB `X'0006'`（GRDB 内部编码，非明文整数）；用户 SFM 菜单栏截图显示勾选 `singbox`。

## 根因

- 错误假设：schema 第 2 列叫 `remark`（凭记忆写列名，未先 `.schema` 核对）
- 错误假设：`length(BLOB)` ≈ BLOB 存储的值
- 缺失检查点：SELECT 后没有用 `SELECT *` 或 `.schema` 对齐列名与列序；结论没有与独立证据（用户实际状态）交叉验证就输出

## 修复

- BLOB 一律 `quote(data)` 解码，不读长度
- 结论输出前对照独立证据（用户截图 = 实际激活 singbox）
- 涉及用户当前状态的断言，标注证据来源

## 预防

- 查任何 SQLite 表前先 `.schema <table>`，SELECT 用显式列名且列名来自 `.schema` 输出，不凭记忆
- 上述检查已固化为 `sb-sync profile` 子命令（见 scripts/sb-sync-rs/src/profile.rs）：读 SFM settings.db 前先 PRAGMA 校验 profiles 表列名集合，缺列即报错；BLOB 一律不做业务推断（selected_profile_id 编码未破译，激活判定明示「未验证」并指向 SFM 菜单）
- 对「用户当前状态」类结论：单一数据源不定论，必须与第二证据（UI 截图/日志/用户口述）对上才输出
