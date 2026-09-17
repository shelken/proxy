# proxy

个人自维护的代理软件配置/插件/脚本集合

## 目录

- `config/loon/`: Loon 配置与插件（移动端 + macOS 桌面端），含 `plugins/` 插件目录与各端 `.conf` 配置
- `config/clash/`、`config/surge/`: 备用客户端配置
- `scripts/`: 构建等脚本
- `.github/workflows/`: CI 工作流

## 基本原则

- 优先从github进行搜索类似需求的代码, 参考实现, 根据用户需求进行规划
- 任何代理软件的配置必须阅读最新文档, 禁止使用被任何标记为废弃的配置项
- 禁止读取任何隐私配置, 读取到任何 订阅链接/密码 必须停止

## 开发约束

- 项目开源, 在不暴露隐私且脚本插件正常运行的前提下进行代码编写
- 优先 使用新的API/新的语法/新的特性
- 对于目标网站的接口调用, 除非用户允许, 否则不要使用穷举探测的方式进行处理
- 测试统一用 bun 运行，入口为 `justfile`：`just test` 跑全部，`just run-test <关键字>` 按名过滤，`just test-sign` 为指定插件快捷方式；运行 `just test` 前确保 `bun test` 可用
- 所有网络rule的测试, 必须在沙箱/容器中进行测试; 不准直接修改本地任何实际在用的规则
- 禁止在本地或容器中执行任何临时`安装包`的操作

## Loon

- mac下的loon配置在`~/Library/Mobile Documents/iCloud~com~ruikq~decar/Documents/mac/mac.lcf`; 读取时必须过滤掉`[Proxy]`,`[Remote Proxy]`,`[Mitm]` 三个敏感的配置块

## 参考项目

- `https://github.com/chavyleung/scripts/`: 各种脚本参考
- `https://sing-box.sagernet.org/configuration/`: sing-box配置文档
- `https://sing-box.sagernet.org/changelog`: sing-box更新日志
