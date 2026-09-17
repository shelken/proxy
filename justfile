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
    @bun run scripts/test-by-name.mjs {{name}}

# 中国移动签到插件测试
test-sign:
    @just run-test cmcc-sign

# --- 沙箱 VM 生命周期 ---
# 创建沙箱 VM（一次性）
vm-create:
    limactl create --name={{vm_name}} --tty=false {{justfile_directory()}}/config/sing-box/lima.yaml

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
# 同步点：把被测配置复制到 VM 内的可写工作目录。
# 只复制手写的公开层模板：生成的登记引用磁盘上的规则集产物，而沙箱里既没有那些产物，
# 它的 tag 也会与测试覆盖层的内联定义撞车。
sync-sandbox:
    {{lima_shell}} rm -rf /work/sing-box
    {{lima_shell}} mkdir -p /work/sing-box/tests /work/sing-box/tools
    {{lima_shell}} cp {{repo_in_guest}}/config/sing-box/conf.d/10-public.json /work/sing-box/public.json
    {{lima_shell}} cp -r {{repo_in_guest}}/config/sing-box/tests/. /work/sing-box/tests/
    # 合成器要在沙箱内跑：脚本与它读的两份数据文件一起复制进 guest。
    {{lima_shell}} cp {{repo_in_guest}}/scripts/singbox_rules.py {{repo_in_guest}}/scripts/singbox_nodes.py /work/sing-box/tools/
    {{lima_shell}} cp {{repo_in_guest}}/config/rules/index.txt {{repo_in_guest}}/config/rules/policy-order.txt /work/sing-box/tools/

# 在沙箱内运行全部网络行为测试
test-sandbox: sync-sandbox
    {{lima_shell}} /opt/proxy-test/bin/bun test /work/sing-box/tests

# 只跑某一层，例如 just test-sandbox-layer dns
test-sandbox-layer name: sync-sandbox
    {{lima_shell}} /opt/proxy-test/bin/bun test /work/sing-box/tests/{{name}}.test.js

# 在沙箱内校验配置（公开层 + 测试覆盖层）。
# 覆盖层用同一批 tag 指向本地夹具、注入最小内联规则集，因此沙箱里不放真实拓扑与生成产物。
check-sandbox: sync-sandbox
    {{lima_shell}} /opt/proxy-test/bin/sing-box check -c /work/sing-box/public.json -c /work/sing-box/tests/overlay.json

# --- 规则生成与校验（跑在宿主机，需要联网拉第三方列表） ---
# 生成全部客户端的规则产物
build-rules:
    uv run python -B scripts/singbox_rules.py build --all

# 生成器的单元测试（不触网）
test-rules:
    bun test scripts/singbox_rules.test.js

# --- 真实订阅体检（跑在宿主机，需要能连到节点） ---
# 解包 → 解析 → 结构校验 → 逐节点真实握手测延迟。
# 订阅体只进内存，临时配置写在临时目录、结束即删；只监听 127.0.0.1，不建 TUN、不改路由。
# 用法：just verify-sub ~/sub.txt   或   just verify-sub 'https://<机场>/sub?token=...'
verify-sub source:
    @uv run python -B scripts/verify_subscription.py {{source}}

# 校验生产配置：先用一份文档级夹具合成 darwin 配置（设备实际拿到的形态），再让内核校验。
# 夹具只用 RFC 5737 的测试网段与保留 UUID，不含任何真实凭据。
# 合成器把公开层模板、内网参数、节点出站与规则集登记拼成一份，所以这里校验的就是完整那一份。
check-singbox:
    @uv run python -B scripts/singbox_rules.py compose --input config/sing-box/tests/compose-input.json --output /tmp/singbox-composed.json && sing-box check -c /tmp/singbox-composed.json && rm -f /tmp/singbox-composed.json
