# 加密订阅与服务端

用户运行 encode 得到加密订阅 URL，服务端解密后返回 sing-box 配置。

## Sub-features

- `encode` 覆盖短旗标、长旗标、参数顺序和默认配置路径
- `roundtrip` 覆盖真实加密、解密、节点装配、overlay 合并和反回环规则
- `subscription` 覆盖 URI 行与 Base64 订阅抓取
- `server-http` 覆盖 `/healthz`、`/pubkey`、`/sub` 与无效请求
- `dynamic-template` 覆盖公开 HTTPS 模板下载
- `clipboard` 覆盖 macOS 实际剪切板写入与原内容恢复

## How to get to it (user POV)

运行 `sbtools encode -s <server> [-c <config.yaml>]` 或长旗标。服务端设置 `SERVER_PRIVATE_KEY` 与 `SING_BOX` 后运行 `sbtools server --port <port>`。客户端访问 encode 生成的 `/sub?d=` URL。

## Driving it with verify-sbtools

Preconditions:

- Launch 与 Doctor 完成
- 公网组可以在 VM 内访问公开模板

运行 `bun --no-env-file .agents/skills/verify-sbtools/helpers/verify.js drive --out "$RUN" --suite server,remote,mac`。

服务端组用实际 keygen 和 server 启动实例。使用实际 encode 生成 URL，再请求该 URL。核对节点地址与协议、overlay 值、策略组和规则优先级。两次 encode 的密文不同，解密配置一致。缺参数、坏密文、坏私钥和坏内核路径返回对应错误。

公网组从被测提交的公开地址下载 template，并检查服务端日志显示 `底模: dynamic`。

## Gotchas

Linux 没有 pbcopy 时应输出手动复制提示。macOS 组由原生剪切板 API 核对 URL 并恢复全部原数据类型；若其他应用同时写入剪切板，不覆盖其新内容，报告失败。URL 和密钥只使用合成输入。服务端响应证明装配与合并，不证明合成代理节点可连接。
