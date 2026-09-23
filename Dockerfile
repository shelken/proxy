# sb-sync-server 镜像：sb-sync（服务端形态）+ 官方 sing-box CLI。
# sing-box 版本固定 1.14.1：merge 行为随版本变化，升级需重跑合并回归测试。
FROM ghcr.io/sagernet/sing-box:v1.14.1 AS singbox

# rust 1.97：Cargo.lock 中 icu_* 要求 rustc ≥1.88，1.85 直接编译失败。
# alpine + build-base：ureq→rustls→ring 需要 C 工具链。
FROM rust:1.97-alpine AS builder
RUN apk add --no-cache build-base
WORKDIR /build
COPY scripts/sb-sync-rs/Cargo.toml scripts/sb-sync-rs/Cargo.lock ./
COPY scripts/sb-sync-rs/src/ ./src/
# include_str! 从 crate 根退出三级：/build/src/../../../config = /config（非 /build/config）
COPY config/sing-box/template.json /config/sing-box/template.json
RUN cargo build --release

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=singbox /usr/local/bin/sing-box /usr/local/bin/sing-box
COPY --from=builder /build/target/release/sb-sync /usr/local/bin/sb-sync
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["sb-sync"]
CMD ["server"]
