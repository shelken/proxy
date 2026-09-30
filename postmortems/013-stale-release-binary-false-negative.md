# 验证直接跑旧 release 产物得出假阴性

**日期**: 2026-09-30
**影响**: 协调者在验证 PR3 guard 修复时跑了修复前构建的旧 release 二进制,得出「修复未生效」的错误结论,排查一圈才发现是二进制没重建
**发现人**: 协调者自检

## 问题

执行了 `git pull` 与 `just verify`(通过),随即运行 `./target/release/sbtools logs -f` 验证行为,输出仍为旧的静默回退形态

## 现象

```sh
# 代码已含 bbd60f3 修复,但:
HOME=<fakehome-guard> ./target/release/sbtools logs -f
# 仍输出: v 跟踪 127.0.0.1:9090 (静默回退到缺省口)
```

## 根因

错误假设:`just verify` 会重新构建 release 产物。实际 `just verify` 只跑 `cargo test`,属于 debug profile;`target/release/sbtools` 的 mtime 仍停留在数小时前前一执行者构建的旧提交上,用新代码测旧二进制

## 修复

显式执行 `cargo build --release -p sbtools` 后重跑 smoke,验证立即通过(exit 1 拒绝)

## 预防

- 凡通过 `target/release/<bin>` 做行为验证的,命令前必须显式带 `cargo build --release`,不假设任何其他任务帮建过
- 自查二进制指纹:测试前读一次 `git rev-parse HEAD` 与 `strings ./target/release/<bin> | grep ...`,或者测前 `rm -f target/release/<bin>` 逼迫重编
