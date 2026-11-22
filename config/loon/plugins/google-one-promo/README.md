# Google One 优惠档改写（google-one-promo）

将 Google One iOS 商品目录（`one.google.com/ai`）里的内购档替换为限时优惠档：

| 原始 iOS 内购 ID | 替换为（主档 90p → 备用 75p） |
| --- | --- |
| `g1.ios.20tb.m.v2` | `g1.20tb.3months_ip_90p.acq` / `g1.20tb.3months_ip_75p.acq` |
| `g1.ios.30tb.ai.pro.m` | `g1.ai.ultra.3months_ip_90p.acq` / `g1.ai.ultra.3months_ip_75p.acq` |

规则：优惠档必须真实出现在目录响应里才替换；主档缺失时自动降级备用档。优惠档是限时促销品，每次命中都会在 Loon 日志输出「目录探测」列出响应中真实存在的所有优惠档，以日志为准增删 `promo.js` 里的 `SKU_MAP`。

需要 Loon 开启 MITM 并信任证书。

## 配置

```ini
[Plugin]
https://raw.githubusercontent.com/shelken/proxy/main/config/loon/plugins/google-one-promo/google-one-promo.lpx
```

或一键添加：[Google One 优惠档改写](https://www.nsloon.com/openloon/import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2Fshelken%2Fproxy%2Frefs%2Fheads%2Fmain%2Fconfig%2Floon%2Fplugins%2Fgoogle-one-promo%2Fgoogle-one-promo.lpx)

插件参数 `enabled` 可整体关闭改写。

## 测试

```sh
just run-test promo
```
