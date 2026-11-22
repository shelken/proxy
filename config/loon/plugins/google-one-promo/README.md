# Google One 优惠档改写（google-one-promo）

改写 Google One `/ai` 商品目录响应，把 iOS 内购档 ID 直接替换为限时优惠档。纯 Rewrite 实现，无脚本。

| 原始 iOS 内购 ID | 替换为 |
| --- | --- |
| `g1.ios.20tb.m.v2` | `g1.20tb.3months_ip_90p.acq` |
| `g1.ios.30tb.ai.pro.m` | `g1.ai.ultra.3months_ip_90p.acq` |

请求侧同步删除 `Accept-Encoding`：Loon 不自动解压 br/gzip 响应，压缩 body 无法改写。

需要 Loon 开启 MITM 并信任证书。

## 配置

```ini
[Plugin]
https://raw.githubusercontent.com/shelken/proxy/main/config/loon/plugins/google-one-promo/google-one-promo.lpx
```

或一键添加：[Google One 优惠档改写](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fshelken%2Fproxy%2Frefs%2Fheads%2Fmain%2Fconfig%2Floon%2Fplugins%2Fgoogle-one-promo%2Fgoogle-one-promo.lpx)

## 维护

优惠档是限时促销品。若页面白屏、卡片消失或订阅弹窗报「项目不可用」，说明 90p 档已不在目录：把 lpx 中替换值里的 `_90p` 改成 `_75p`（备用档 `g1.20tb.3months_ip_75p.acq` / `g1.ai.ultra.3months_ip_75p.acq`）。
