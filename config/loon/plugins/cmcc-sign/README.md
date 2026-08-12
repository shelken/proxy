# 中国移动签到有礼

Loon 插件：进入中国移动 APP 后自动保存自动登录凭据，每日定时自动续期并签到「签到有礼」活动。

## 引入

在 Loon 主配置 `[Plugin]` 区块添加：

```
[Plugin]
https://raw.githubusercontent.com/shelken/proxy/main/config/loon/plugins/cmcc-sign/cmcc-sign.lpx, enabled=true
```

## 使用

1. Loon 开启 MITM 并信任证书（插件已声明 `wx.10086.cn` 与 `client.app.coc.10086.cn`）
2. 打开中国移动 APP，收到「凭据已更新」通知即完成首次保存
3. 之后每日按设定时间自动签到，通知签到结果与本月已签天数

## 配置

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `captureEnabled` | `true` | 是否自动提取凭据 |
| `signEnabled` | `true` | 是否执行定时签到 |
| `signTime` | `30 0,1 * * *` | 0:30 签到，1:30 自动补试 |
| `notify` | `true` | 是否发送签到结果通知 |

## 测试

```
just test-sign
```

## 注意

- 首次需打开中国移动 APP 完成凭据保存；快照冷却满 60 分钟后可用于签到
- 自动保留最近 3 条快照；若首次执行仍在冷却，下一次定时任务会自动补试
- 若重新登录 APP 或凭据失效，重新打开 APP 即可自动更新
- 若 APP 更新活动接口，需重新观测确认
