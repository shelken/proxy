# 测试运行入口（统一用 bun 执行所有 *.test.js）
# 用法：
#   just test           # 运行全部测试
#   just run-test cmcc  # 运行指定测试（按文件名模糊匹配）
#   just test-sign      # 中国移动签到插件测试（快捷方式）

test_files := `find . -name "*.test.js" -not -path "./.git/*" -not -path "./node_modules/*"`

# 运行全部测试
test:
    @if [ -z "{{test_files}}" ]; then echo "未找到任何 *.test.js"; exit 1; fi
    bun test --test-specifier {{test_files}}

# 运行指定测试（按关键字过滤，如 just run-test cmcc）
run-test name:
    @bun run scripts/test-by-name.mjs {{name}}

# 中国移动签到插件测试
test-sign:
    @just run-test cmcc-sign
