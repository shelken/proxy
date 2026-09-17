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
    limactl create --name=proxy-test --tty=false {{justfile_directory()}}/config/sing-box/lima.yaml

# 启动沙箱 VM
vm-start:
    limactl start --tty=false proxy-test

# 停止沙箱 VM
vm-stop:
    limactl stop proxy-test

# 删除沙箱 VM
vm-delete:
    limactl delete --force proxy-test

# --- 沙箱测试 ---
# 同步点：把被测配置复制到 VM 内的可写工作目录。
# 只复制手写的公开层模板：生成的登记引用磁盘上的规则集产物，而沙箱里既没有那些产物，
# 它的 tag 也会与测试覆盖层的内联定义撞车。
sync-sandbox:
    limactl shell proxy-test rm -rf /work/sing-box
    limactl shell proxy-test mkdir -p /work/sing-box/tests
    limactl shell proxy-test cp {{repo_in_guest}}/config/sing-box/conf.d/10-public.json /work/sing-box/public.json
    limactl shell proxy-test cp -r {{repo_in_guest}}/config/sing-box/tests/. /work/sing-box/tests/

# 在沙箱内运行全部网络行为测试
test-sandbox: sync-sandbox
    limactl shell proxy-test /opt/proxy-test/bin/bun test /work/sing-box/tests

# 只跑某一层，例如 just test-sandbox-layer dns
test-sandbox-layer name: sync-sandbox
    limactl shell proxy-test /opt/proxy-test/bin/bun test /work/sing-box/tests/{{name}}.test.js

# 在沙箱内校验配置（公开层 + 测试覆盖层）。
# 覆盖层用同一批 tag 指向本地夹具、注入最小内联规则集，因此沙箱里不放真实拓扑与生成产物。
check-sandbox: sync-sandbox
    limactl shell proxy-test /opt/proxy-test/bin/sing-box check -c /work/sing-box/public.json -c /work/sing-box/tests/overlay.json

# --- 规则生成与校验（跑在宿主机，需要联网拉第三方列表） ---
# 生成全部客户端的规则产物
build-rules:
    uv run python -B scripts/singbox_rules.py build --all

# 生成器的单元测试（不触网）
test-rules:
    bun test scripts/singbox_rules.test.js

# 校验生产配置（公开层 + 生成的规则集登记 + 私有拓扑模板）。
# -D 不可省略：45-ruleset.json 里的 rule_set.path 相对工作目录解析。
# sing-box 合并配置目录时按路径名排序，命令行传入的先后无效，所以 10-public.json 恒在
# 45-ruleset.json 之前，内网直连规则先于列表规则生效。
check-singbox:
    sing-box check -D config/sing-box -C conf.d -c local/99-topology.json.example
