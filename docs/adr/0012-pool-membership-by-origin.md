# 出站引用完整性：池按来源判定，路由目标装配期收口

## Problem

`selfhost` 池承载「自建节点」，`proxy` 默认指向它，邮件规则也指向它。它的成员资格由 tag 正则 `(?i)(vps|hy2|selfhost)` 决定，这条正则两个方向都错：机场节点自称 `vps-hk` 会混进池，邮件被送去机场；自建节点改中文名则漏收，邮件直接失败。

同时，装配器只剪策略组引用、`default` 与 DNS detour，`route.rules[].outbound` 无人收口。内核 `check` 不校验该位置（实测：引用未声明 tag 时 check 通过），缺失引用只在命中该规则时报 `outbound not found`。

约束：不新增业务策略组（客户端菜单不能变长）；不为单个服务往装配器堆特判；`selfhost` 属基础设施池，出现在菜单可接受。

## Usage

模板侧只写令牌，不写名字：

```jsonc
{ "type": "selector", "tag": "selfhost", "outbounds": ["@declared"] }
```

服务端调用不变：

```rust
let nodes = assemble::collect_nodes(&sources, &input)?;   // 返回 NodeSet，带来源
let (mut tpl, source) = template::load_template(url)?;
assemble::finalize(&mut tpl, nodes)?;                     // 不变量在此收口
```

产物侧：

```jsonc
// 有 nodes: 直写 —— 池存在，邮件规则保留
"selfhost": { "outbounds": ["mine"] }
"route.rules": [{ "rule_set": "MySelfhost", "outbound": "selfhost" }]

// 纯机场 —— 池消失，规则整条移除并告警
"selfhost": 不存在
"route.rules": [ /* 无 MySelfhost */ ]
```

## Shape

**数据结构**

```rust
pub struct NodeSet {
    pub nodes: Vec<Value>,
    /// 前 declared 个来自 nodes: 直写，其余来自订阅。
    pub declared: usize,
}
```

来源是节点在收集阶段的固有属性，不是事后推断。`collect_nodes` 本来就分 `private_nodes` 与 `airport_nodes` 两个 vec，只需把分界点带出来。

**令牌而非分支**

```rust
const TOKEN_DECLARED: &str = "@declared";
```

`populate_selectors` 展开成员时先认令牌。模板数据里看得见「这个池收什么」，装配器不认识任何具体组名。

**收口点唯一**

```rust
fn prune_route_targets(template: &mut Value, available: &HashSet<String>, fallback: &str)
```

在 `finalize` 末尾、DNS detour 处理之后调用一次。它和已有的 detour 回退共用同一个 `available` 集合，不新增遍历阶段。

**不变量**：产物中任何路由目标必须落在出站集合内，否则该规则不存在。

**接口深度**：对外只多一个 `NodeSet` 类型和一个令牌常量。复杂度全部收进 `finalize` 内部：来源切片、令牌展开、悬空清理都在一次调用里完成，调用方无需知道顺序。

## Synthesis decision

三个候选收敛到同一诊断（池按名字判定是根因），分歧在落点：

- 候选 A 把出站引用建成 `RefSite` 三元组表，覆盖 5 类站点，扩展性最好，但要引入新模块与错误类型
- 候选 B 把角色做成装配器常量表（26 个 tag 全量登记），语义最清晰，但要维护一份与模板平行的清单
- 候选 C 新增 `policies/*.yaml` 契约层与 `policy.json` 产物，编译期校验最强，但引入第二个真相源

取 A 的不变量表述与 B 的「池/业务组分离」判断，否决 C 的新增产物层。落点选在 `finalize` 内部而非新模块：当前只有一处收口点，抽象成独立模块会变成单实现接口。

## Tradeoffs accepted

- 接受池消失时邮件规则被移除，换取不留下内核只在命中时报错的悬空引用
- 接受 `NodeSet` 破坏 `finalize` 签名，换取来源信息不靠事后推断
- 接受 `@declared` 这个非 sing-box 原生语法出现在模板里，换取池语义在数据中可见
- 不接受把悬空规则改指 `proxy`：那是把流量送去用户明确排除的线路

## Alternatives considered

**dummy 占位出站**：给池垫一个 `block`。实测 `finalize` 会丢弃顶层非 selector 出站；若保留，`proxy.default` 会恢复指向它，无自建时默认流量落到占位（`block` → 502，`direct` → 真实 IP 直连）。否决。

**新增 `mail` 业务组**：违反「菜单不能变长」。否决。

**`encode` 阶段硬性前置检查**：订阅-only 场景被拦。否决。

**悬空规则改指 reject**：满足不新增组、不落机场，但让邮件连接必然失败。用户要求订阅-only 也要可用，否决。

## Open questions and risks

- `@declared` 是模板里的自定义令牌，远程底模若由旧版装配器处理会把它当正则编译失败。旧底模 + 新装配器不受影响；新底模 + 旧装配器会显式报错而非静默出错。
- `proxy.default` 仍指向 `selfhost`。纯机场场景下装配器会移除该 default（既有行为），`proxy` 退回首个机场节点。是否要让这个回退更显式，留待观察。

## Next implementation step

已实现。后续若要覆盖更多引用站点（`inbounds[].detour`、`http_clients[].detour`），把 `prune_route_targets` 泛化成按站点遍历即可，不需要改调用方。
