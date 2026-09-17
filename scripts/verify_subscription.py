#!/usr/bin/env python3
"""真实订阅体检：解包 → 解析 → 结构校验 → 逐节点真实握手测延迟。

输出只有节点名、协议、服务器与延迟，凭据不进终端；握手测试走内核自己的 Clash API
延迟接口，失败时再各真连一次，把它在内核日志里的报错原话带出来。

隐私与隔离：订阅体只在内存里过一次，临时配置写在 mkdtemp 目录、结束即连同凭据删除；
只监听 127.0.0.1 上两个空闲端口（混合入口与 Clash API），不建 TUN、不改路由、
不碰正在使用的客户端配置。

用法：
    python -B scripts/verify_subscription.py ~/sub.txt
    python -B scripts/verify_subscription.py 'https://<机场>/sub?token=...'
    cat sub.txt | python -B scripts/verify_subscription.py -
    # 文件里直接写订阅链接也行，工具会先把它拉回来再体检：
    #   /tmp/secret.txt 内容 = 一行 https://<机场>/sub?token=...  ＋ 若干明文节点链接
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from singbox_nodes import NodeError, build_nodes, parse_subscription

DELAY_TARGET = "https://www.gstatic.com/generate_204"
USER_AGENT = "proxy-verify-subscription/1.0"


def find_sing_box() -> str:
    """内核路径：环境变量 → PATH → mise 的安装目录（mise 的 shim 常常不在 PATH 上）。"""
    override = os.environ.get("SING_BOX")
    if override:
        return override
    found = shutil.which("sing-box")
    if found:
        return found
    root = Path.home() / ".local/share/mise/installs/sing-box"
    if root.is_dir():
        for version in sorted(root.iterdir(), reverse=True):
            candidate = version / "sing-box"
            if candidate.is_file():
                return str(candidate)
    raise SystemExit("找不到 sing-box：装一个，或用 SING_BOX 指向它")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_port(port: int, proc: subprocess.Popen, timeout: float = 12.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        with socket.socket() as sock:
            sock.settimeout(0.3)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


def collect_links(text: str, notes: list[str]) -> list[str]:
    """源内容 → 链接列表。

    文件里可能直接写着订阅链接（而不是订阅体），那就先把它拉回来 —— 否则那条
    https:// 只会被当成一个协议名认不出的链接跳过，人却以为订阅拉过了。
    """
    lines = [line.strip() for line in text.splitlines()]
    urls = [
        line for line in lines if line.startswith(("http://", "https://")) and not line.startswith("#")
    ]
    links: list[str] = []
    if urls:
        rest = "\n".join(line for line in lines if line not in urls)
        for url in dict.fromkeys(urls):
            host = urllib.parse.urlsplit(url).hostname or "未知主机"
            notes.append(f"源里写着订阅链接，现拉一份：{host}")
            links.extend(parse_subscription(load_body(url)))
        links.extend(parse_subscription(rest))
    else:
        links.extend(parse_subscription(text))
    return list(dict.fromkeys(links))


def load_body(source: str) -> str:
    """订阅链接就现拉，其余当成文件路径，`-` 读 stdin。"""
    if source == "-":
        return sys.stdin.read()
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(source, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            raise SystemExit(f"拉取订阅失败：HTTP {error.code}") from error
        except urllib.error.URLError as error:
            raise SystemExit(f"拉取订阅失败：{error.reason}") from error
    path = Path(source).expanduser()
    if not path.is_file():
        raise SystemExit(f"找不到订阅文件：{source}")
    return path.read_text(encoding="utf-8")


def api_request(
    port: int,
    secret: str,
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {secret}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode() or "{}")


def measure(port: int, secret: str, tag: str, target: str, timeout_ms: int) -> tuple[int | None, str]:
    """通过 Clash API 让内核真的连一次，返回 (延迟毫秒, 失败原因)。

    注意内核只认 https 目标：query 里的 url 若以 http:// 开头会被丢掉、退回它自己的
    默认值，所以目标必须是 https。
    """
    query = urllib.parse.urlencode({"timeout": timeout_ms, "url": target})
    path = f"/proxies/{urllib.parse.quote(tag, safe='')}/delay?{query}"
    try:
        payload = api_request(port, secret, path, timeout=timeout_ms / 1000 + 5)
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read().decode()).get("message", "")
        except Exception:  # noqa: BLE001 - 失败原因解析不出来也不能拖垮体检
            detail = ""
        return None, detail or f"HTTP {error.code}"
    except Exception as error:  # noqa: BLE001
        return None, type(error).__name__
    return int(payload.get("delay", 0)), ""


def build_client_config(
    nodes: list[dict[str, Any]],
    mixed_port: int,
    api_port: int,
    secret: str,
    baseline: str,
    selector: str,
    log_path: Path,
) -> dict[str, Any]:
    return {
        # 日志落文件：Clash API 在延迟测试失败时只回一句笼统的话，真正的原因只在内核日志里。
        "log": {"level": "info", "output": str(log_path)},
        "inbounds": [
            {
                "type": "mixed",
                "tag": "verify-in",
                "listen": "127.0.0.1",
                "listen_port": mixed_port,
            }
        ],
        "outbounds": [
            *nodes,
            # 排查用：一个可切换的分组，配合 Clash API 把流量钉到某个节点上，好让内核
            # 在日志里说出它到底为什么连不上。
            {
                "type": "selector",
                "tag": selector,
                "outbounds": [node["tag"] for node in nodes],
                "default": nodes[0]["tag"],
            },
            {"type": "direct", "tag": baseline},
        ],
        "route": {"final": selector},
        "experimental": {
            "clash_api": {"external_controller": f"127.0.0.1:{api_port}", "secret": secret}
        },
    }


def last_error_since(log_path: Path, offset: int) -> str:
    """读 offset 之后新增日志里最后一条 ERROR 的原话。

    诊断阶段一次只连一个节点，所以新增里的最后一条 ERROR 就是它的原因；不按 tag 过滤，
    是因为内核把连接失败记在分组身上（`using outbound/selector[verify]`），节点名不一定出现。
    """
    if not log_path.is_file():
        return ""
    with log_path.open(encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        text = handle.read()
    found = ""
    for raw in text.splitlines():
        if "ERROR" in raw:
            found = raw.split("ERROR", 1)[1].split("]", 1)[-1].strip()
    return found


def explain_failures(
    api_port: int,
    secret: str,
    mixed_port: int,
    selector: str,
    tags: list[str],
    target: str,
    log_path: Path,
    limit: int = 3,
) -> dict[str, str]:
    """对失败节点各做一次真实请求，把它在内核日志里的报错原话捞回来。

    多花几秒，但换来「是解析错了、还是节点本身连不上」这个关键区别。
    """
    reasons: dict[str, str] = {}
    for tag in tags[:limit]:
        try:
            api_request(
                api_port,
                secret,
                f"/proxies/{urllib.parse.quote(selector, safe='')}",
                method="PUT",
                body={"name": tag},
            )
        except Exception:  # noqa: BLE001 - 切不过去就跳过这条诊断
            continue
        offset = log_path.stat().st_size if log_path.is_file() else 0
        # https 目标要显式配到 https 上：只写 http 键的话 urllib 会直连，绕过被测节点，
        # 那样就永远拿不到这个节点的报错。
        proxy = urllib.request.ProxyHandler(
            {"http": f"http://127.0.0.1:{mixed_port}", "https": f"http://127.0.0.1:{mixed_port}"}
        )
        opener = urllib.request.build_opener(proxy)
        try:
            opener.open(target, timeout=8).read()
        except Exception:  # noqa: BLE001 - 失败正是我们要的
            pass
        time.sleep(0.3)  # 内核写日志可能落后一拍
        reasons[tag] = last_error_since(log_path, offset)
    return reasons


def print_table(
    rows: list[tuple[int | None, str, str, str, str]], baseline: tuple[int | None, str]
) -> None:
    width_name = max([len(row[1]) for row in rows] + [4])
    width_server = max([len(row[2]) for row in rows] + [6])
    print()
    print(f"   延迟  {'协议':<10} {'节点':<{width_name}} {'服务器':<{width_server}}".rstrip())
    for latency, name, server, kind, _reason in rows:
        if latency is None:
            print(f"   超时  {kind:<10} {name:<{width_name}} {server:<{width_server}}".rstrip())
        else:
            print(f"{latency:>6}ms {kind:<10} {name:<{width_name}} {server:<{width_server}}".rstrip())
    if baseline[0] is not None:
        print(f"\n   直连基准 {baseline[0]}ms")
    elif baseline[1]:
        print(f"\n   直连基准 不可用（{baseline[1]}）")


def main() -> int:
    parser = argparse.ArgumentParser(description="把一份真实订阅跑一遍体检")
    parser.add_argument("source", help="订阅链接、订阅体文件，或 - 读 stdin")
    parser.add_argument("--timeout", type=float, default=5.0, help="单节点超时秒数，默认 5")
    parser.add_argument("--jobs", type=int, default=8, help="并发数，默认 8")
    parser.add_argument(
        "--target",
        default=DELAY_TARGET,
        help="握手测试的目标，必须 https（内核会丢掉 http:// 的目标），默认 gstatic 204",
    )
    parser.add_argument("--no-delay", action="store_true", help="只解包解析与结构校验，不连节点")
    parser.add_argument(
        "--diagnose",
        type=int,
        default=3,
        help="失败节点里挑几个再真连一次取报错原话，默认 3，0 表示不查",
    )
    args = parser.parse_args()

    target = args.target
    if target.startswith("http://"):
        # 内核的延迟接口只认 https，传 http 会被静默丢掉、退回它自己的默认值。
        print(f"提示：目标 {target} 是 http，内核会忽略它，改用默认 {DELAY_TARGET}")
        target = DELAY_TARGET

    sing_box = find_sing_box()
    notes: list[str] = []
    links = collect_links(load_body(args.source), notes)

    print(f"订阅体检：{args.source if args.source != '-' else 'stdin'}")
    for note in notes:
        print(f"  {note}")
    try:
        # 体检只关心节点本身：分组是端点组装时才需要的东西，这里不生成。
        nodes, problems = build_nodes({"nodes": links})
    except NodeError as error:
        print(f"订阅不可用：{error}", file=sys.stderr)
        return 1

    kinds: dict[str, int] = {}
    for node in nodes:
        kinds[node["type"]] = kinds.get(node["type"], 0) + 1
    summary = " / ".join(f"{kind} {count}" for kind, count in sorted(kinds.items()))

    print(f"  可用节点 {len(nodes)}（{summary}）")
    for problem in problems:
        print(f"  {problem}")

    workdir = Path(tempfile.mkdtemp(prefix="verify-sub-"))
    try:
        check_path = workdir / "check.json"
        log_path = workdir / "box.log"
        mixed_port, api_port = free_port(), free_port()
        secret = os.urandom(16).hex()
        taken = {node["tag"] for node in nodes}
        baseline = "direct" if "direct" not in taken else "direct-2"
        selector = "verify" if "verify" not in taken else "verify-2"
        config = build_client_config(
            nodes, mixed_port, api_port, secret, baseline, selector, log_path
        )
        check_path.write_text(json.dumps(config), encoding="utf-8")

        check = subprocess.run(
            [sing_box, "check", "-c", str(check_path)], capture_output=True, text=True
        )
        if check.returncode != 0:
            print(f"  结构校验：不通过\n{check.stderr.strip()}", file=sys.stderr)
            return 1
        print("  结构校验：通过")

        if args.no_delay:
            return 0

        run_path = workdir / "run.json"
        run_path.write_text(json.dumps(config), encoding="utf-8")
        proc = subprocess.Popen(
            [sing_box, "run", "-D", str(workdir), "-c", str(run_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        kernel_errors: dict[str, str] = {}
        try:
            if not (wait_port(mixed_port, proc) and wait_port(api_port, proc)):
                print(f"  内核没起来，看日志：{log_path}", file=sys.stderr)
                return 1

            timeout_ms = int(args.timeout * 1000)
            print(
                f"  握手测试：{target}，超时 {args.timeout:g}s，并发 {args.jobs}，"
                f"临时配置 {workdir}（结束即删）"
            )

            with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
                baseline_future = pool.submit(measure, api_port, secret, baseline, target, timeout_ms)
                futures = {
                    node["tag"]: pool.submit(measure, api_port, secret, node["tag"], target, timeout_ms)
                    for node in nodes
                }
                baseline = baseline_future.result()
                results = {tag: future.result() for tag, future in futures.items()}

            failing = [node["tag"] for node in nodes if results[node["tag"]][0] is None]
            if failing and args.diagnose > 0:
                print(f"  排查失败节点（前 {min(args.diagnose, len(failing))} 个各真连一次）…")
                kernel_errors = explain_failures(
                    api_port,
                    secret,
                    mixed_port,
                    selector,
                    failing,
                    target,
                    log_path,
                    limit=args.diagnose,
                )
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    rows = []
    for node in nodes:
        latency, reason = results[node["tag"]]
        rows.append(
            (latency, node["tag"], f"{node['server']}:{node['server_port']}", node["type"], reason)
        )
    ordered = sorted(rows, key=lambda row: (row[0] is None, row[0] or 0))
    print_table(ordered, baseline)

    alive = sum(1 for row in rows if row[0] is not None)
    print(f"\n  合计 {len(rows)}：可用 {alive}，失败 {len(rows) - alive}")
    if kernel_errors:
        print("\n  失败原话（内核日志，最多看 3 个）：")
        for tag, message in kernel_errors.items():
            print(f"    {tag}：{message or '（日志里没留下报错，可能是对端静默丢弃）'}")
    return 0 if alive else 1


if __name__ == "__main__":
    sys.exit(main())
