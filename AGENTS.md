# proxy

个人自维护的代理软件配置/插件/脚本集合

## 布局

- `config/loon/plugins/`: Loon 插件，每插件一个目录，插件规范见其中的 `AGENTS.md`
- `config/sing-box/`: 底模 `template.json`（由 `modules/` 装配生成）与沙箱行为测试 `tests/`
- `config/rules/`: 自定义规则源，`index.yaml` 为清单
- `scripts/sbtools-rs/`: sbtools 源码，文档见 `docs/sbtools.md`
- `docs/`: 入口 `ARCH.md`（全局架构）、`adr/`（设计决策）、`sbtools.md`、`user-guide/`
- `GLOSSARY.md`: 共享领域词汇

## 约束

- 读取 mac 端 Loon 配置 `~/Library/Mobile Documents/iCloud~com~ruikq~decar/Documents/mac/mac.lcf` 前，先滤掉 `[Proxy]`、`[Remote Proxy]`、`[Mitm]` 三个敏感配置块
- 不读取任何私有节点配置与凭据（如 `~/.config/sing-box/config.yaml`），一旦看到订阅链接或密码立即停止并报告
- 编码、测试与 sing-box/规则集变更前先读 `CODING_STANDARDS.md`
