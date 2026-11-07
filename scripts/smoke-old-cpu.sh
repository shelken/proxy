#!/usr/bin/env bash
# 在模拟的旧 CPU 上跑 sbtools 服务端，并让它发起一次 HTTPS 订阅请求。
#
# 为什么需要：GitHub runner 的 CPU 都支持 BMI/AVX2，原生冒烟测不出「二进制里混进
# 了旧 CPU 不支持的指令」。2026-11 runner 升到 ubuntu-26.04 后，发布的 x86_64 二进制
# 在 Ivy Bridge 机器上 SIGILL（见 #157），CI 全绿却到线上才暴露。
# TLS 握手开头就会生成 x25519 密钥，足以走到出问题的代码，所以用本地 TLS 服务当订阅源，
# 证书校验失败（返回 400）没关系，只要服务端没崩。
#
# 用法: smoke-old-cpu.sh <x86_64 二进制> [qemu CPU 型号，默认 IvyBridge]
# 依赖: qemu-user、openssl、curl
set -euo pipefail

BIN=$(realpath "$1")
CPU=${2:-IvyBridge}
RUN=(qemu-x86_64 -cpu "$CPU")
WORK=$(mktemp -d)
PIDS=()
cleanup() { kill "${PIDS[@]}" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

cd "$WORK"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout key.pem -out cert.pem -subj "/CN=localhost" -days 1 2>/dev/null
openssl s_server -quiet -accept 18443 -cert cert.pem -key key.pem -www >/dev/null 2>&1 &
PIDS+=($!)

SK=$("${RUN[@]}" "$BIN" keygen | sed -n 's/^SERVER_PRIVATE_KEY=//p')
SERVER_PRIVATE_KEY=$SK PORT=18080 "${RUN[@]}" "$BIN" server >server.log 2>&1 &
PIDS+=($!)

for _ in $(seq 1 30); do
  curl -fsS --max-time 2 http://127.0.0.1:18080/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:18080/healthz >/dev/null || { echo "服务端未起来"; cat server.log; exit 1; }

printf 'subs:\n  - https://127.0.0.1:18443/\n' > cfg.yaml
URL=$("${RUN[@]}" "$BIN" encode -s http://127.0.0.1:18080 -c cfg.yaml | tail -1)

CODE=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$URL" || true)
echo "HTTPS 订阅请求返回 $CODE"
if [ "$CODE" = 000 ] || ! curl -fsS --max-time 5 http://127.0.0.1:18080/healthz >/dev/null; then
  echo "服务端在 $CPU 上处理 HTTPS 时崩溃（非法指令？）"
  cat server.log
  exit 1
fi
echo "OK: 在 $CPU 上 HTTPS 出站正常"
