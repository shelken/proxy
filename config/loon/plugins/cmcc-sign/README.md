# 中国移动签到有礼

Loon 插件：进入中国移动 APP 后自动保存长效登录凭据，每日定时自动续期并签到「签到有礼」活动。

## 引入

在 Loon 主配置 `[Plugin]` 区块添加：

```
[Plugin]
https://raw.githubusercontent.com/shelken/proxy/main/config/loon/plugins/cmcc-sign/cmcc-sign.lpx, enabled=true
```

## 使用

1. Loon 开启 MITM 并信任证书（插件已声明 `wx.10086.cn` 与 `client.app.coc.10086.cn`）
2. 打开中国移动 APP（任意页面），收到「凭据已更新」通知即完成首次保存
3. 之后每日按设定时间自动续期并签到，通知签到结果与本月已签天数

## 配置

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `signTime` | `30 7 * * *` | 每日签到时间（cron 表达式） |
| `notify` | `true` | 是否发送签到结果通知 |

## 测试

```
just test-sign
```

## 注意

- 首次需打开中国移动 APP 完成凭据保存；之后 APP 登录态有效期间无需重复打开
- 若 APP 登录态失效（长时间未登录），需重新打开 APP
- 若 APP 更新活动接口，需重新观测确认
