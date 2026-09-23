# sb-sync-server 镜像：sb-sync（服务端形态）+ 官方 sing-box CLI。
# sing-box 版本固定 1.14.1：merge 行为随版本变化，升级需重跑合并回归测试。
FROM ghcr.io/sagernet/sing-box:v1.14.1 AS singbox

FROM rust:1.85-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY scripts/sb-sync-rs/Cargo.toml scripts/sb-sync-rs/Cargo.lock ./
COPY scripts/sb-sync-rs/src/ ./src/
# include_str!("../../../config/sing-box/template.json") 相对 src/ 的上两级 = /build
COPY config/sing-box/template.json /build/config/sing-box/template.json
RUN cargo build --release

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
COPY --from=builder /build/target/release/sb-sync /usr/local/bin/sb-sync
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["sb-sync"]
CMD ["server"]
