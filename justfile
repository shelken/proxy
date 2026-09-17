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
# 同步点：把被测配置与装配代码复制到 VM 内的可写工作目录。
# 只复制手写的公开层模板：生成的登记引用磁盘上的规则集产物，而沙箱里既没有那些产物，
# 它的 tag 也会与测试覆盖层的内联定义撞车。
sync-sandbox:
    {{lima_shell}} rm -rf /work/sing-box
    {{lima_shell}} mkdir -p /work/sing-box/tests /work/sing-box/tools
    {{lima_shell}} cp {{repo_in_guest}}/config/sing-box/conf.d/10-public.json /work/sing-box/public.json
    {{lima_shell}} cp {{repo_in_guest}}/config/sing-box/template.json /work/sing-box/template.json
    {{lima_shell}} cp -r {{repo_in_guest}}/config/sing-box/tests/. /work/sing-box/tests/
    # 装配走仓库里真实的端点核心，沙箱测试不另抄一份装配规则。
    {{lima_shell}} cp {{repo_in_guest}}/scripts/endpoint.mjs {{repo_in_guest}}/scripts/singbox_rules.py /work/sing-box/tools/
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

# 内核命令：优先用环境变量 SING_BOX，缺省走 mise exec -- sing-box
sing_box_cmd := env_var_or_default("SING_BOX", "mise exec -- sing-box")

# --- 生产底模校验与容器化订阅验证 ---
# 校验标准生产底模：校验 template.json 包含的完整规则集引用与入站/DNS结构
check-singbox:
    @{{sing_box_cmd}} check -c config/sing-box/template.json

# 启动本地 sublink 转换容器
sublink-up:
    @docker run -d --name proxy-sublink -p 8787:8787 --rm ghcr.io/7sageer/sublink-worker:latest >/dev/null && echo "sublink-worker running on http://127.0.0.1:8787"

# 停止本地 sublink 容器
sublink-down:
    @docker stop proxy-sublink >/dev/null 2>&1 || true

# 本地等价验证单 URL 契约：解析后端取节点 → 底模装配 → sing-box check，全程零上传
# 用法：just verify-endpoint /tmp/secret.txt [/tmp/singbox.json]
#      just verify-endpoint 'https://<机场订阅>'
# 需要 --node / --dns / --zone 时直接调脚本（just 不转发额外参数）：
#      bun run scripts/endpoint.mjs /tmp/secret.txt /tmp/singbox.json --node 'vless://...' --dns 192.168.6.1 --zone ooooo.space
verify-endpoint source output="/tmp/singbox.json":
    @bun run scripts/endpoint.mjs {{source}} {{output}}

# 本地点起端点（单 URL 契约）：
#   just serve                     → http://127.0.0.1:8080/darwin?sub=…&node=…&dns=…&zone=…
#   just serve 8080 192.168.5.2    → 绑到沙箱 VM 能访问的地址，让 VM 当"设备"直接取配置
serve port="8080" host="127.0.0.1":
    @bun run scripts/endpoint.mjs --serve --port {{port}} --host {{host}}
