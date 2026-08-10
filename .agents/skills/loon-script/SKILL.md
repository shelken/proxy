---
name: loon-script
description: 编写、修改、调试 Loon 脚本（http-request / http-response / cron）或 .lpx 插件时阅读; 涉及 $httpClient / $request / $response / $done / $persistentStore / $notification / $argument / requires-body / MITM / 定时任务时阅读
---

# Loon 脚本最佳实践

## 文档指路（不重复内容，需要细节时去查）

- 官方脚本格式与 API：https://nsloon.app/docs/Script/ 和 https://nsloon.app/docs/Script/script_api（也可看 GitHub 镜像 Loon0x00/LoonExampleConfig 的 Script/ 目录）
- 插件 .lpx 格式：https://nsloon.app/docs/Plugin/
- 中文教程（格式入门、cron 表达式）：https://github.com/chiupam/tutorial/tree/master/Loon/Plus
- 官方插件参数示例：LoonExampleConfig 的 Plugin/Plugin_Arg.plugin（新版 `[Argument]` + `$argument`）与 Plugin_Example4.plugin（老式 `#!input` + `$persistentStore.read`）
- 本仓库现成示例：`config/loon/plugins/youtube.lpx`（Argument 传参 + http-response 写法）；`config/loon/plugins/cmcc-sign/`（签到类完整工程：lpx 引用远程脚本 + 纯函数可单测 + 动态 header + 双脚本协作），均为参考实现

API 细节一律以上述文档为准，本文件只记录写法和判断。

## 关键模型：脚本 = 触发条件 + 处理器

Loon 脚本由两部分组成，先定触发，再写处理器：

1. **触发条件**（写在配置/插件里，决定何时执行）
   - `http-request <正则>`：请求发出时触发
   - `http-response <正则>`：拿到响应时触发
   - `cron "<表达式>"`：定时触发（5 段：分时日月周）
2. **处理器**（JS 文件）：`$request`/`$response` 读数据，`$httpClient` 发起网络请求，最后必须 `$done()` 收尾

> 触发型脚本（非 cron）要生效，必须：① URL 能匹配上正则 ② 域名在 `[MITM]` 里且已信任证书。cron 不依赖 MITM。

## 写脚本 SOP

1. **确定类型**：改请求/拿响应数据 → `http-request`/`http-response`；定时签到、状态检查 → `cron`
2. **流量观测确认 URL 正则**：用流量观测工具确认目标接口的 URL 形态，写能精确匹配的正则（只匹配必要路径，避免误伤同域其他接口）
3. **写 JS 处理器**：按下方模板，先处理异常路径（error 判断、JSON.parse 包 try/catch），成功路径最后再写
4. **挂载**：主配置 `[Script]` 或插件 `[Script]` 区块，`script-path=` 指向本地路径或远程 URL
5. **验证**：打开 Loon 日志面板触发一次，确认脚本命中、`console.log` 输出符合预期、`$done` 后请求行为正确（改 body 就确认响应已变；reject 就确认请求被断）

## 处理器最小模板

### http-request（改请求头 / 伪响应）

```js
if (!$request) { console.log('非触发型运行'); }  // 直接运行会报错，$request 只在触发时有值

// 改请求头：$done 传 headers 覆盖原请求头
$done({ headers: { ...$request.headers, 'X-New': '1' } });

// 伪响应（拦截类）：$done 传 response，请求不再发往服务器
$done({ response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' } });
```

### http-response（改响应体）

```js
// 改 JSON 响应：requires-body=true 时 $response.body 才有值
try {
  const obj = JSON.parse($response.body);
  obj.removeMe = undefined;
  $done({ body: JSON.stringify(obj) });
} catch (e) {
  console.log('解析失败，原样放行: ' + e);
  $done({});  // 任何分支都要 $done
}
```

### cron（定时任务 + 网络请求 + 通知）

```js
$httpClient.get('https://api.example.com/check', (err, resp, data) => {
  if (err) { $notification.post('任务失败', '', err); return $done(); }
  const ok = JSON.parse(data).ok;
  if (ok) { $notification.post('任务成功', '', '一切正常'); }
  $done();  // 回调里收尾，见下方「$done 时机」坑
});
```

## 插件 .lpx 结构与脚本托管（重要）

- `.lpx` 是**纯文本单文件**（`#!` 头 + 各区块），不是 zip 包，无法内嵌脚本文件
- `script-path` 引用**相对路径**（如 `remove_ads.js`）仅对 Loon 本地脚本（从本机文件系统读）有效
- URL 导入的 `.lpx` 若要跑自定义脚本，`script-path` 必须指向**远程 URL**（如 `https://raw.githubusercontent.com/<repo>/<path>/xxx.js`），社区标准做法
- 因此：插件配置与脚本分开存仓库（`xxx.lpx` + 同目录脚本文件），lpx 引用仓库 raw URL

## 脚本工程化（可测试）

需要请求外部接口并解析响应的脚本（签到/查询/通知类），推荐结构：

1. **纯函数与 Loon 环境分离**：解析响应、编排流程写成不依赖 `$httpClient`/`$notification`/`$persistentStore` 的函数，请求函数、通知函数、收尾回调均**依赖注入**（作为参数传入），便于脱离 Loon 单测
2. **同目录写 `*.test.js`**（bun test）：测试从脚本源文件提取纯函数部分（如按注释分隔截取），mock 注入的请求函数断言调用次数/参数，mock 通知函数断言通知内容
3. **顶层函数名避免与 `$httpClient.post` 等全局方法同名**（如不要叫 `post`），否则作用域遮蔽导致诡异报错；用 `requestPost` 等独特命名

## 动态请求头（不写死）

涉及登录态/UA 的接口，header 写死会在客户端版本更新或环境变化后失效。通用模式：

1. **观测脚本**（http-response 匹配登录态相关请求）：把**完整请求头存持久化**（JSON.stringify，去掉 Cookie 键、去空值键），同时单独提取并存储登录凭据（如 token/cookie）
2. **业务脚本**（cron 定时任务）：读取存储的请求头，**优先用动态头，缺失字段 fallback 写死值；认证凭据永远用最新值覆盖**（如 Cookie 用新 token 重建）

## 幂等与防重复执行

Loon **无内置防重入机制**：cron 到点即触发，重复执行（多触发、手动补跑、配置刷新重跑）由脚本自己保证幂等。对签到/领奖/打卡等“一天一次”类任务，最低限度必须做到**同一天只执行一次**：

1. **存上次执行日期**：`$persistentStore` 存 `YYYYMMDD`（key 带插件名前缀，如 `cmcc_sign_last`）
2. **执行前判断**：读存储日期 == 今天 → 跳过本次，通知/日志说明“今日已执行”，不再调接口
3. **执行后落盘**：无论成功/失败，都写今日日期（失败也记录，避免当日反复重试刷接口）
4. **判断逻辑写成纯函数**（如 `shouldSign(dateStr, store)` + `markSigned(dateStr, store)`，store 注入读写接口），可单测：首次不跳过 / 同日跳过 / 跨天不跳过

参考实现：`config/loon/plugins/cmcc-sign/sign.js`。

**捕获类（http-request/http-response）脚本同样要幂等**：这类脚本每次请求/响应都会触发，用户反复进出页面会重复执行。对“提取凭据/存 cookie”类脚本，副作用必须幂等：

- **token/凭据去重**：提取前先读旧值，`newToken === oldToken` 时静默更新（仍刷新 headers，但不再写 token、不再发通知）；仅当值变化（重新登录）才写 + 通知
- **判断写成纯函数**（如 `shouldUpdateToken(newToken, oldToken)`），可单测：首次更新 / 同值不更新 / 变化才更新
- 触发本身无法从配置层减少（http-response 每次命中必执行），只能保证每次执行的副作用幂等

参考实现：`config/loon/plugins/cmcc-sign/capture.js`。

> 若需防“同脚本并发重入”（上一轮未结束下一轮开始），Loon 无全局锁 API，可记录 `startTime` 到 `$persistentStore` 做粗略互斥（如 5 分钟内不重入），但准确性与一致性有限，仅作兜底。

## 变量获取与设置（跨脚本共享）

脚本里的变量有三个来源，先判断属于哪类再选 API：

1. **静态配置参数 → `$argument`**：用户在插件 UI 填写的值（`[Argument]` 的 input/select/switch），经脚本行 `argument=[{参数名}]` 传入，JS 里读 `$argument.参数名`。只随插件设置变化，适合开关、账号等用户可配项
2. **动态运行时数据 → `$persistentStore`**：跨脚本/跨运行共享的状态（cookie、缓存、计数）。**必须显式传 key**——不传 key 时以当前脚本名 hash 为 key，是隔离的私有空间，别的脚本读不到；传相同 key 才能共享
3. **运行期配置/策略状态 → `$config`**：当前配置、策略组选中项（`$config.getSelectedPolicy("组名")`）、运行模式等，只读为主

### 持久化读写规范（$persistentStore）

```js
// 写：存储只支持字符串，对象先序列化；key 带插件名前缀防冲突
$persistentStore.write(JSON.stringify(obj), "myplugin_cache");

// 读：判空后再 JSON.parse，避免解析报错
const raw = $persistentStore.read("myplugin_cache");
const obj = raw ? JSON.parse(raw) : {};
```

- key 统一用 `插件名_` 前缀命名，避免与别的脚本撞 key
- `$persistentStore.remove()` 清空**所有**脚本的本地数据，仅限调试

### 典型共享模式：一写多读

提取 cookie 的 http-request 脚本负责写，cron 签到脚本负责读：写方在请求回调里存储；读方每次运行先 `read` → 判空 → 为空时通知用户重新提取，不要静默失败

## 最佳实践与坑（按重要性）

- **$done 时机**：`$done()` 会释放脚本资源。异步回调（$httpClient、setTimeout）里必须等任务完成再 `$done`；在异步之外先调 `$done`，回调里的代码不会执行
- **每个分支都要收尾**：触发型脚本无论成功/失败/异常，都必须走一个 `$done`（异常时 `$done({})` 原样放行），否则请求挂起
- **改 body 的前提**：配置里要 `requires-body=true`，否则 `$response.body` / `$request.body` 拿不到；处理二进制响应（如图片）加 `binary-body-mode=true`，body 是 Uint8Array
- **$done 传参语义**：`$done()` 无参 = 放弃请求断开连接；`$done({})` 空对象 = 原样放行；传 `headers`/`body` 只覆盖对应字段，未传字段保留原值；清空 body 传 `body=""`，清空 headers 传 `headers={}`
- **http-request 伪响应 vs http-response**：拦截广告用 `http-request` + `$done({response:...})`（省流量）；拿真实响应再改（如豆瓣评分）才用 `http-response`
- **timeout 单位是毫秒**（Surge 是秒）：`$httpClient` 的 `timeout: 2000` 是 2 秒；配置行里的 `timeout=` 才是秒
- **指定出口节点**：`$httpClient` 传 `node: "策略组名"` 可让该请求走指定策略
- **变量三来源**：静态参数走 `$argument`、跨脚本共享走 `$persistentStore`（显式 key）、运行期状态走 `$config`，详见上方「变量获取与设置」
- **调试**：`console.log($request)` 打印完整结构；`$loon` 可输出 Loon 版本/判断运行环境；改完先日志面板看输出再收尾
- **插件规则限制**：.lpx 内 `[Rule]` 只能用 DIRECT / REJECT 系 / PROXY，不能引用用户策略组
- **上游同步**：从上游拉 .lpx 时保留 `#!author` 等元信息，只按项目约束调整 `#!homepage`/`#!icon`
- **资源链接必须校验**：插件内所有 URL（`#!icon`、`#!homepage`、`script-path` 远程脚本、README 里的引入链接）交付前必须逐个 HTTP 校验状态码（`curl -sI -o /dev/null -w "%{http_code}" <url>`，期望 200；GitHub raw 404 常见原因是文件名/大小写/路径不匹配，用 GitHub API 树接口查真实路径再改）

## 验证清单（交付前）

- [ ] 正则只匹配目标接口，不误伤
- [ ] 每个分支都有 `$done`，且 `$done` 在异步完成之后
- [ ] 涉及 body 读写的地方，配置有 `requires-body=true`
- [ ] 二进制处理处有 `binary-body-mode=true`（如适用）
- [ ] 触发型脚本的域名在 `[MITM]` 中
- [ ] JSON.parse 有 try/catch，失败原样放行
- [ ] 跨脚本共享数据用显式 key 读写（非默认脚本名 hash），key 带插件名前缀
- [ ] 涉及登录态/UA 的脚本，header 尽量动态获取（捕获时存持久化，签到读），不全部写死
- [ ] cron/签到类脚本有幂等保证：同日去重（存上次执行日期，同天跳过），执行后写日期
- [ ] 插件内所有资源链接（icon/homepage/script-path/README 引入链接）已逐个 HTTP 校验，返回 200
- [ ] 在 Loon 日志面板实测命中并输出预期
