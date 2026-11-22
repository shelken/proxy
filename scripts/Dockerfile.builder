# 本地编译 Linux musl 版 sbtools 的轻量构建镜像。
FROM rust:1-alpine
RUN apk add --no-cache musl-dev
