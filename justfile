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
# 一个入口产出两份底模：Mac（modules/）与 iOS（modules/ + modules-ios/）。
# 不需要记住该跑哪一条，也不需要判断改动落在哪一侧：两侧都重算，只报告真的变了的那份。
# 合并用官方 merge：文件名（前缀数字）决定 route.rules / outbounds 的数组顺序。
template-build:
    #!/usr/bin/env bash
    set -euo pipefail
    d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-build.XXXXXX")"
    trap 'rm -rf "$d"' EXIT
    mkdir "$d/ios"
    # iOS 以 modules 为底，modules-ios 同名替换并新增（ADR-0010）。
    # 必须复制到同一目录：`-C` 按完整路径排序合并，两个目录分开传会让 modules-ios 排在前面而被覆盖。
    cp config/sing-box/modules/*.json "$d/ios"
    cp config/sing-box/modules-ios/*.json "$d/ios"

    # 先合并到临时文件再比对，才能区分「重算了」与「真的变了」。
    # merge 的 stderr 平常只写输出路径，失败时才是错误信息，所以只在失败时展示。
    emit() {
        if ! {{sing_box_cmd}} merge "$d/out.json" -C "$2" >"$d/merge.log" 2>&1; then
            cat "$d/merge.log"
            echo "❌ 合并 $1 失败"
            exit 1
        fi
        if cmp -s "$1" "$d/out.json"; then
            echo "·  $1 无变化"
        else
            cp "$d/out.json" "$1"
            echo "✏️  $1 已更新"
        fi
    }
    emit config/sing-box/template.json config/sing-box/modules
    emit config/sing-box/template-ios.json "$d/ios"

    {{sing_box_cmd}} check -c config/sing-box/template.json
    {{sing_box_cmd}} check -c config/sing-box/template-ios.json

# 校验两份底模与 modules 一致，并做结构 check 与废弃写法检查。
# check 只做 box.New 不 Start()，抓不到悬空 tag 引用与规则顺序，那部分由 template-test 覆盖。
template-check:
    #!/usr/bin/env bash
    set -euo pipefail
    d="$(mktemp -d "${TMPDIR:-/tmp}/sing-box-check.XXXXXX")"
    trap 'rm -rf "$d"' EXIT
    mkdir "$d/ios"
    cp config/sing-box/modules/*.json "$d/ios"
    cp config/sing-box/modules-ios/*.json "$d/ios"

    if ! {{sing_box_cmd}} merge "$d/mac.json" -C config/sing-box/modules >"$d/merge-mac.log" 2>&1; then
        cat "$d/merge-mac.log"; echo "❌ 合并 template.json 失败"; exit 1
    fi
    if ! {{sing_box_cmd}} merge "$d/ios.json" -C "$d/ios" >"$d/merge-ios.log" 2>&1; then
        cat "$d/merge-ios.log"; echo "❌ 合并 template-ios.json 失败"; exit 1
    fi

    failed=0
    for pair in "template.json:$d/mac.json" "template-ios.json:$d/ios.json"; do
        want="config/sing-box/${pair%%:*}"
        got="${pair##*:}"
        if diff -u "$want" "$got"; then
            echo "✅ $want 与 modules 一致"
        else
            echo "❌ $want 与 modules 不一致，请运行 just template-build"
            failed=1
        fi
    done
    [ "$failed" -eq 0 ] || exit 1

    # 一份 check 同时覆盖两件事：配置结构合法 + 无废弃写法。
    # 内核对废弃字段只报 WARN 不失败，这里把 WARN 升级为失败。
    for tpl in template.json template-ios.json; do
        out=$({{sing_box_cmd}} check -c "config/sing-box/$tpl" 2>&1) || {
            printf '%s\n' "$out"
            echo "❌ config/sing-box/$tpl 未通过内核 check"
            exit 1
        }
        if printf '%s\n' "$out" | grep -qi deprecated; then
            printf '%s\n' "$out"
            echo "❌ config/sing-box/$tpl 存在废弃写法（见上方 WARN）"
            exit 1
        fi
    done
    echo "✅ 两份底模通过内核 check，无废弃写法"

# 底模结构契约测试：引用闭合、顺序契约、iOS 差异面白名单（ADR-0012）
template-test:
    #!/usr/bin/env bash
    set -euo pipefail
    # 内核路径缺失时直接报清楚，否则会落到沙箱默认路径、报出无关的「文件不存在」
    kernel="${SING_BOX:-$(command -v sing-box || true)}"
    if [ -z "$kernel" ]; then
        echo "❌ 找不到 sing-box：设置 SING_BOX，或确保它在 PATH 上（mise exec -- bun test ...）"
        exit 1
    fi
    SING_BOX="$kernel" bun test \
        config/sing-box/tests/template.test.ts \
        config/sing-box/tests/ios-template.test.ts \
        config/sing-box/tests/order-contract.test.ts

# 变异验证：把已知有害的改动施加到临时副本，断言必须失败（ADR-0012）。
# 放在 verify 而非 pre-commit：要跑十余次真实测试，秒级成本不适合每次提交。
template-mutation:
    @bun run scripts/verify-assertions.ts

# 校验标准生产底模：单独跑时用，check-template 已内含同等检查
check-singbox:
    @{{sing_box_cmd}} check -c config/sing-box/template.json

# 废弃写法检查：单独跑时用，check-template 已内含同等检查
check-deprecated:
    #!/usr/bin/env bash
    set -euo pipefail
    failed=0
    for tpl in template.json template-ios.json; do
        out=$({{sing_box_cmd}} check -c "config/sing-box/$tpl" 2>&1)
        rc=$?
        printf '%s\n' "$out"
        [ "$rc" -eq 0 ] || exit "$rc"
        if printf '%s\n' "$out" | grep -qi deprecated; then
            echo "❌ config/sing-box/$tpl 存在废弃写法（见上方 WARN）"
            failed=1
        fi
    done
    [ "$failed" -eq 0 ]


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

# sing-box 底模：两侧一致 + 结构 check + 废弃写法 + 契约测试
check-template:
    @just template-check
    @just template-test

# 全量检查（手动跑 / CI 同口径）；变异验证只在这里跑，见 template-mutation
verify: check-rust-fast check-rust-test check-template template-mutation rules-check


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
