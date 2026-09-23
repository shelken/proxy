# sb-sync-server 镜像：sb-sync（服务端形态）+ 官方 sing-box CLI。
#
# 单平台构建：每平台在原生 runner 上单独构建并推送 digest，最后由合并 job
# 组装 manifest list。二进制由 CI 预编译后 COPY 进来，镜像构建不再重复编译。
#
# 构建上下文要求 sb-sync 二进制位于 ./sb-sync（由 workflow 就地产出后放入）。
FROM ghcr.io/sagernet/sing-box:v1.14.1 AS singbox

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
# artifact 上传/下载不保留文件权限（GitHub Actions 的已知行为），COPY 会原样带上
# 缺失的可执行位，容器启动即 127 «executable file not found in $PATH»。显式补上。
COPY sb-sync /usr/local/bin/sb-sync
RUN chmod +x /usr/local/bin/sb-sync
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["sb-sync"]
CMD ["server"]
