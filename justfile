# 测试运行入口（统一用 bun 执行所有 *.test.js）
# 用法：
#   just test              # 运行全部测试
#   just run-test cmcc     # 运行指定测试（按文件名模糊匹配）
#   just test-sign         # 中国移动签到插件测试（快捷方式）
#
# sing-box 的网络行为测试不在本机跑。它们在沙箱 VM 内执行，入口见文件末尾。
# 它们被排除在宿主机测试之外：那些用例会创建 TUN、改写路由表，
# 在宿主机上跑会破坏正在使用的网络。

# 本仓库在沙箱 VM 内的路径。lima.yaml 把宿主家目录挂成只读的 /host-home，
# 所以这里把 $HOME 前缀换掉即可，不需要写死用户名或绝对路径。
repo_in_guest := replace(justfile_directory(), env_var_or_default("HOME", ""), "/host-home")

# 沙箱 VM 名与 guest 内的入口，只在这里写一次。
vm_name := "proxy-test"
# limactl shell 默认把宿主当前目录当工作目录 cd 进 guest，而那条路径在 guest 里并不存在，
# 于是每条命令执行前都会喷一行 `cd: ... No such file or directory`。固定 guest 侧工作目录。
lima_shell := "limactl shell --workdir /work " + vm_name

# 运行全部测试
test:
    @just run-test test

# 运行指定测试（按关键字过滤，如 just run-test cmcc）
run-test name:
    @bun run scripts/test-by-name.ts {{name}}

# 中国移动签到插件测试
test-sign:
    @just run-test cmcc-sign

# --- 沙箱 VM 生命周期 ---
# 创建沙箱 VM（一次性）。内核版本取自 .mise.toml（反引号在每次执行该 recipe 时求值，
# 不会影响其他 recipe），并通过 Lima 参数传给 provision。
vm-create:
    limactl create --name={{vm_name}} --tty=false --param SING_BOX_VERSION="{{`mise config get --file .mise.toml tools.sing-box`}}" {{justfile_directory()}}/config/sing-box/lima.yaml

# 启动沙箱 VM
vm-start:
    limactl start --tty=false {{vm_name}}

# 停止沙箱 VM
vm-stop:
    limactl stop {{vm_name}}

# 删除沙箱 VM
vm-delete:
    limactl delete --force {{vm_name}}

# --- 沙箱测试 ---
# 闭环引导：取 HEAD 的 CI 产物 → 拷入 VM → VM 内起服务端 → 取回它实际响应的配置
# 后处理为可驱动内核的形式。配置来源是服务端产物，不再是本地等价实现（ADR-0003）。
sandbox-loop:
    @bun run scripts/sandbox-loop.ts

# 在沙箱内运行全部网络行为测试（先引导，再跑断言）
test-sandbox: sandbox-loop
    {{lima_shell}} /opt/proxy-test/bin/bun test /work/sing-box/tests

# 只跑闭环相关测试（引导已完成时用，省一次产物下载与会话启动）
test-loop:
    {{lima_shell}} /opt/proxy-test/bin/bun test /work/sing-box/tests/loop.test.ts



# DNS 对照只依赖合成上游，可在服务端产物构建前验证模板策略。
test-dns name="":
    {{lima_shell}} /opt/proxy-test/bin/bun --no-env-file test {{repo_in_guest}}/config/sing-box/tests/dns-behavior.test.js --test-name-pattern '{{name}}'

# 内核命令：优先用环境变量 SING_BOX，缺省走 mise exec -- sing-box
sing_box_cmd := env_var_or_default("SING_BOX", "mise exec -- sing-box")


# --- 生产底模装配与校验 ---
# 单入口：一次重建 mac 与 iOS 两份底模。
# 开发时只跑这一条命令，无需记住两个产物各自怎么生成；
# 结束时报告哪份产物发生了变化。语义校验在 just check-template。
template-build:
    #!/usr/bin/env bash
    set -euo pipefail
    # mac：直接从 modules 合并（文件名前缀决定数组顺序）
    {{sing_box_cmd}} merge config/sing-box/template.json -C config/sing-box/modules
    # iOS：modules 为底，modules-ios 同名替换并新增（ADR-0010）。
    # 分两步 cp 是为了兼容 GNU cp 的 -C 目录覆盖行为（户检 014）
    d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-ios.XXXXXX")"
    trap 'rm -rf "$d"' EXIT
    cp config/sing-box/modules/*.json "$d"
    cp config/sing-box/modules-ios/*.json "$d"
    {{sing_box_cmd}} merge config/sing-box/template-ios.json -C "$d"
    # 报告哪份产物变了，方便确认改动范围没超出预期
    for t in template.json template-ios.json; do
        if git diff --quiet -- "config/sing-box/$t"; then
            echo "✅ config/sing-box/$t 未变化"
        else
            echo "📝 config/sing-box/$t 已更新"
        fi
    done

# 校验 template.json 与 modules 一致：用内核重跑一次逐字节比对
template-check:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp="$(mktemp "${TMPDIR:-/tmp}/sing-box-template.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    {{sing_box_cmd}} merge "$tmp" -C config/sing-box/modules >/dev/null
    if ! diff -u config/sing-box/template.json "$tmp"; then
        echo "❌ config/sing-box/template.json 与 modules/ 不一致，请运行 just template-build 更新底模"
        exit 1
    fi
    echo "✅ config/sing-box/template.json 与 modules/ 检查一致"

# iOS 底模由 just template-build 一并生成，不再单独提供 build 入口

# 校验 template-ios.json 与 modules + modules-ios 一致
template-ios-check:
    #!/usr/bin/env bash
    set -euo pipefail
    d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-ios.XXXXXX")"
    trap 'rm -rf "$d"' EXIT
    cp config/sing-box/modules/*.json "$d"
    cp config/sing-box/modules-ios/*.json "$d"
    {{sing_box_cmd}} merge "$d.merged.json" -C "$d" >/dev/null 2>&1
    trap 'rm -rf "$d" "$d.merged.json"' EXIT
    if ! diff -u config/sing-box/template-ios.json "$d.merged.json"; then
        echo "❌ template-ios.json 与 modules + modules-ios 不一致，请运行 just template-build"
        exit 1
    fi
    {{sing_box_cmd}} check -D "$d" -c "$PWD/config/sing-box/template-ios.json"
    echo "✅ template-ios.json 检查一致"

# 校验标准生产底模：校验 template.json 包含的完整规则集引用与入站/DNS结构
check-singbox:
    @{{sing_box_cmd}} check -c config/sing-box/template.json

# 废弃写法检查：内核对废弃字段只报 WARN 不失败，这里把 WARN 升级为失败
check-deprecated:
    #!/usr/bin/env bash
    out=$({{sing_box_cmd}} check -C config/sing-box/modules 2>&1)
    rc=$?
    printf '%s\n' "$out"
    [ "$rc" -eq 0 ] || exit "$rc"
    if printf '%s\n' "$out" | grep -qi deprecated; then
        echo "❌ config/sing-box/modules 存在废弃写法（见上方 WARN）"
        exit 1
    fi


# --- 规则产物 ---
# 编译全部规则产物（联网拉上游清单，需 sing-box 编译 .srs）
rules-build:
    @bun scripts/rules-compile.ts build --all

# 只构建单个 tag（如 just rules-build-one OpenAI）
rules-build-one tag:
    @bun scripts/rules-compile.ts build {{tag}}

# 校验清单（index.yaml）的 tag 集合与底模（template.json）声明是否一致
# 改了底模的规则集引用却忘了同步清单时，这里会直接报出是哪个 tag
rules-check:
    @bun scripts/rules-compile.ts check


# --- 提交前检查：按改动范围分组，pre-commit 用 files 只触发相关那组 ---
check-rust-fast:
    cargo fmt --all --check
    cargo machete
    cargo clippy --workspace --all-targets --locked -- -D warnings

check-rust-test:
    cargo test --workspace --locked

# sing-box 底模：modules 与 template 一致 + 结构 check + 废弃写法 + 模板测试
check-template:
    @just template-check
    @just template-ios-check
    @just check-singbox
    @just check-deprecated
    SING_BOX=$(which sing-box) bun test config/sing-box/tests/template.test.ts config/sing-box/tests/ios-template.test.ts

# 全量检查（手动跑 / CI 同口径）
verify: check-rust-fast check-rust-test check-template rules-check


# 在沙箱中全链路追踪指定域名的分流与真实出口节点
# 用法: just trace google.com
#       just trace api.openai.com
#       just trace foo.ooooo.space
trace domain="google.com":
    @bun run scripts/trace-route.ts {{domain}}

# 在沙箱中对真实数据 DNS 拓扑做系统性观测（成功率/延迟/路径判别/出口区域）
# 用法: just dns-observe（报告落 dns-observe-report.json，不入库）
dns-observe:
    @bun run scripts/dns-observe.ts
