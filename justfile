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


# 内核命令：优先用环境变量 SING_BOX，缺省走 mise exec -- sing-box
sing_box_cmd := env_var_or_default("SING_BOX", "mise exec -- sing-box")


# --- 生产底模校验与容器化订阅验证 ---
# 校验标准生产底模：校验 template.json 包含的完整规则集引用与入站/DNS结构
check-singbox:
    @{{sing_box_cmd}} check -c config/sing-box/template.json


# --- 规则产物 ---
# 编译全部规则产物（联网拉上游清单，需 sing-box 编译 .srs）
rules-build:
    @bun scripts/rules-compile.ts build --all

# 只构建单个 tag（如 just rules-build-one OpenAI）
rules-build-one tag:
    @bun scripts/rules-compile.ts build {{tag}}

# 校验清单（index.txt）与底模（template.json）路由是否一致
# 改了底模的路由分组却忘了同步清单 policy 时，这里会直接报出是哪个 tag
rules-check:
    @bun scripts/rules-compile.ts check


# 在沙箱中全链路追踪指定域名的分流与真实出口节点
# 用法: just trace google.com
#       just trace api.openai.com
#       just trace foo.ooooo.space
trace domain="google.com":
    @bun run scripts/trace-route.ts {{domain}}
