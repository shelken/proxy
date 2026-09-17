from __future__ import annotations

import base64
import binascii
import json
import re
from typing import Any, Callable
from urllib.parse import ParseResult, parse_qs, unquote, urlparse

# 早期数据（Xray 的 ws 0-RTT）写在 path 尾部，内核要的是两个独立字段。
EARLY_DATA_RE = re.compile(r"[?&]ed=(\d+)$")

# 内核支持的 ss 加密方式。认不出的直接跳过：一个坏 method 会让整份配置校验失败。
SS_METHODS = {
    "none",
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "aes-128-gcm",
    "aes-192-gcm",
    "aes-256-gcm",
    "chacha20-ietf-poly1305",
    "xchacha20-ietf-poly1305",
    "aes-128-ctr",
    "aes-192-ctr",
    "aes-256-ctr",
    "aes-128-cfb",
    "aes-192-cfb",
    "aes-256-cfb",
    "rc4-md5",
}
SS_METHOD_ALIASES = {
    "chacha20-poly1305": "chacha20-ietf-poly1305",
    "xchacha20-poly1305": "xchacha20-ietf-poly1305",
}

VMESS_SECURITIES = {"auto", "none", "zero", "aes-128-gcm", "chacha20-poly1305"}

# JSON 里的 net 取值到内核 transport 的映射，取不到就是这一版内核表达不了的传输。
VMESS_TRANSPORTS = {
    "": "",
    "tcp": "",
    "raw": "",
    "ws": "ws",
    "grpc": "grpc",
    "h2": "http",
    "http": "http",
    "httpupgrade": "httpupgrade",
    "quic": "quic",
}


class NodeError(ValueError):
    """单个节点不可用。调用方跳过它，其余节点照常产出。"""


def decode_base64(text: str) -> str | None:
    """宽松 base64 解码，解不开返回 None。

    订阅体与 vmess 链接都不保证补齐 padding，也可能用 URL-safe 字母表，
    标准库的严格接口会因此直接抛错。
    """
    compact = re.sub(r"\s+", "", text)
    if not compact:
        return None
    padded = compact + "=" * (-len(compact) % 4)
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            return decoder(padded).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            continue
    return None


def split_links(text: str) -> list[str]:
    """挑出链接行，忽略空行与注释行。"""
    return [line for line in (raw.strip() for raw in text.splitlines()) if line and not line.startswith("#")]


def parse_subscription(body: str) -> list[str]:
    """订阅体 → 链接列表。

    机场多数回 base64，少数回明文。先看明文：base64 的字符集里不含 ':'，
    所以只要出现 '://' 就能断定是明文，两种形态不会互相误判。
    """
    if "://" in body:
        return split_links(body)
    decoded = decode_base64(body)
    if decoded and "://" in decoded:
        return split_links(decoded)
    return []


def query_of(parsed: ParseResult) -> dict[str, str]:
    """query 参数，同名取首个；空值保留，便于区分「没写」与「写了空」。"""
    return {key: values[0] for key, values in parse_qs(parsed.query, keep_blank_values=True).items()}


def pick(query: dict[str, str], *keys: str) -> str | None:
    """按优先顺序取第一个有意义的参数值。

    同一语义在分享链接里常有多种拼写（sni / peer），并且会塞字面量 "none"、
    "null" 当占位，这两种都当成没写。
    """
    for key in keys:
        value = (query.get(key) or "").strip()
        if value and value.lower() not in ("none", "null"):
            return value
    return None


def flag(query: dict[str, str], *keys: str) -> bool:
    return any((query.get(key) or "").strip().lower() in ("1", "true", "yes") for key in keys)


def host_of(parsed: ParseResult) -> str:
    host = parsed.hostname
    if not host:
        raise NodeError("缺少服务器地址")
    return host


def port_of(parsed: ParseResult, default: int | None = None) -> tuple[int, str | None]:
    """返回 (端口, 备注)。

    端口跳跃链接的端口段形如 `443,5000-6000`，urlparse 解析不了。这里只取第一个
    端口并上报：把端口段翻成 server_ports 没有一手依据，不猜。
    """
    try:
        port = parsed.port
    except ValueError:
        head = parsed.netloc.rsplit("@", 1)[-1].rsplit(":", 1)[-1]
        first = head.split(",", 1)[0]
        if not first.isdigit():
            raise NodeError(f"端口无法解析：{head}") from None
        note = f"多端口链接只用了第一个端口（{head}）" if "," in head else None
        return int(first), note
    if port is None:
        if default is None:
            raise NodeError("缺少端口")
        return default, None
    return port, None


def username_of(parsed: ParseResult) -> str:
    return unquote(parsed.username or "")


def password_of(parsed: ParseResult) -> str:
    return unquote(parsed.password or "")


def raw_userinfo(parsed: ParseResult) -> str:
    """netloc 里 '@' 之前的原文。

    密码里可能带未编码的 ':'，走 urlparse 的 username/password 会被切成两半，
    所以要从 netloc 取原文。
    """
    return unquote(parsed.netloc.rpartition("@")[0])


def split_authority(authority: str) -> tuple[str, int]:
    """把 `host:port` 拆开，容忍 IPv6 的方括号。"""
    host, _, port_text = authority.rpartition(":")
    if not host or not port_text.isdigit():
        raise NodeError(f"地址无法解析：{authority}")
    return host.strip("[]"), int(port_text)


def build_tls(
    query: dict[str, str], *, server_name: str = "", insecure: bool = False
) -> dict[str, Any]:
    """出站 TLS 段。

    参数名按事实标准取值：sni（部分客户端写 peer）、allowInsecure / allow_insecure /
    insecure 都表示跳过校验。
    """
    tls: dict[str, Any] = {"enabled": True}
    name = pick(query, "sni", "peer") or server_name
    if name:
        tls["server_name"] = name
    if insecure or flag(query, "allowInsecure", "allow_insecure", "insecure"):
        tls["insecure"] = True
    alpn = pick(query, "alpn")
    if alpn:
        tls["alpn"] = [item for item in alpn.strip("{}").split(",") if item]
    fingerprint = pick(query, "fp")
    if fingerprint:
        tls["utls"] = {"enabled": True, "fingerprint": fingerprint}
    return tls


def add_reality(tls: dict[str, Any], query: dict[str, str], security: str) -> None:
    """REALITY 段。

    security=reality 却没有公钥的链接是坏的：写半个 reality 段会让内核到运行时
    才报错，所以这里直接判定节点不可用。
    """
    public_key = pick(query, "pbk")
    if security != "reality" and not public_key:
        return
    if not public_key:
        raise NodeError("REALITY 链接缺少公钥")
    reality: dict[str, Any] = {"enabled": True, "public_key": public_key}
    short_id = pick(query, "sid")
    if short_id:
        reality["short_id"] = short_id
    # 内核要求：开了 reality 就必须开 uTLS，否则整份配置在启动阶段被拒
    # （uTLS is required by reality client）。分享链接常只给公钥不给指纹，指纹缺省时
    # 内核按 chrome 走，所以这里只补开关，不编一个指纹出来。
    tls.setdefault("utls", {"enabled": True})
    tls["reality"] = reality


def build_transport(kind: str, query: dict[str, str]) -> dict[str, Any] | None:
    """V2Ray 传输层；tcp 是默认值，不写出站字段。"""
    kind = kind.strip().lower()
    if kind in ("", "tcp", "raw", "none"):
        return None
    host = pick(query, "host")
    path = pick(query, "path") or "/"
    if kind == "ws":
        transport: dict[str, Any] = {"type": "ws"}
        match = EARLY_DATA_RE.search(path)
        if match:
            path = path[: match.start()]
            transport["max_early_data"] = int(match.group(1))
            transport["early_data_header_name"] = "Sec-WebSocket-Protocol"
        transport["path"] = path
        if host:
            transport["headers"] = {"Host": host}
        return transport
    if kind == "grpc":
        transport = {"type": "grpc"}
        service_name = pick(query, "serviceName", "servicename")
        if service_name:
            transport["service_name"] = service_name
        return transport
    if kind in ("http", "h2"):
        transport = {"type": "http"}
        if host:
            transport["host"] = [host]
        transport["path"] = path
        return transport
    if kind == "httpupgrade":
        transport = {"type": "httpupgrade"}
        if host:
            transport["host"] = host
        transport["path"] = path
        return transport
    if kind == "quic":
        return {"type": "quic"}
    raise NodeError(f"不支持的传输层：{kind}")


def transport_host(transport: dict[str, Any] | None) -> str:
    """取传输层里声明的 Host，用作 TLS 的 SNI 兜底。"""
    if not transport:
        return ""
    headers = transport.get("headers") or {}
    return headers.get("Host") or (transport.get("host") or [""])[0]


def build_vless(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    uuid = username_of(parsed)
    if not uuid:
        raise NodeError("缺少 uuid")
    port, note = port_of(parsed)
    if note:
        notes.append(note)
    node: dict[str, Any] = {
        "type": "vless",
        "tag": tag,
        "server": host_of(parsed),
        "server_port": port,
        "uuid": uuid,
    }
    flow = pick(query, "flow")
    if flow:
        # 内核只认 xtls-rprx-vision；旧链接里的 xtls-rprx-* 是 Xray 早期写法，
        # 丢掉它也还是能连上，比整条跳过有用。
        if flow == "xtls-rprx-vision":
            node["flow"] = flow
        else:
            notes.append(f"忽略未知的 flow：{flow}")

    kind = pick(query, "type") or ""
    if not kind and (pick(query, "obfs") or "").lower() in ("websocket", "ws"):
        kind = "ws"
    transport = build_transport(kind, query)
    if transport:
        node["transport"] = transport

    security = (pick(query, "security") or "").lower()
    if security in ("tls", "reality") or flag(query, "tls") or pick(query, "pbk"):
        tls = build_tls(query, server_name=transport_host(transport))
        add_reality(tls, query, security)
        node["tls"] = tls

    encoding = pick(query, "packetEncoding", "packet_encoding")
    if encoding:
        if encoding in ("xudp", "packetaddr"):
            node["packet_encoding"] = encoding
        else:
            notes.append(f"忽略未知的 packet_encoding：{encoding}")
    return node


def build_vmess(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    """vmess 链接是 base64 包着的 v2rayN JSON，不是标准 URI。"""
    text = decode_base64(link.split("://", 1)[1])
    payload: Any = None
    if text:
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None
    if not isinstance(payload, dict):
        raise NodeError("vmess 链接不是 base64 的 JSON")

    server = str(payload.get("add") or "").strip()
    if not server:
        raise NodeError("缺少服务器地址")
    port_text = str(payload.get("port") or "").strip()
    if not port_text.isdigit():
        raise NodeError(f"端口无法解析：{port_text}")
    uuid = str(payload.get("id") or "").strip()
    if not uuid:
        raise NodeError("缺少 uuid")

    security = str(payload.get("scy") or "").strip().lower()
    if security not in VMESS_SECURITIES:
        # v2rayN 会写 http / gun 这类旧值，内核只认固定几种，退回 auto。
        security = "auto"
    node: dict[str, Any] = {
        "type": "vmess",
        "tag": tag,
        "server": server,
        "server_port": int(port_text),
        "uuid": uuid,
        "security": security,
        "alter_id": int(str(payload.get("aid") or "0").strip() or 0),
    }

    net = str(payload.get("net") or "").strip().lower()
    if net not in VMESS_TRANSPORTS:
        raise NodeError(f"不支持的传输层：{net}")
    path = str(payload.get("path") or "")
    transport = build_transport(
        VMESS_TRANSPORTS[net],
        {"path": path, "host": str(payload.get("host") or ""), "serviceName": path},
    )
    if transport:
        node["transport"] = transport

    tls_flag = str(payload.get("tls") or "").strip().lower()
    if tls_flag and tls_flag != "none":
        insecure = bool(payload.get("insecure")) or payload.get("verify_cert") is False
        tls_query = {
            "sni": str(payload.get("sni") or ""),
            "alpn": str(payload.get("alpn") or ""),
            "fp": str(payload.get("fp") or ""),
            "pbk": str(payload.get("pbk") or ""),
            "sid": str(payload.get("sid") or ""),
        }
        default_name = "" if VMESS_TRANSPORTS[net] == "http" else transport_host(transport)
        tls = build_tls(tls_query, server_name=default_name, insecure=insecure)
        add_reality(tls, tls_query, tls_flag)
        node["tls"] = tls
    return node


def normalize_ss_method(method: str) -> str:
    name = method.strip().lower()
    name = SS_METHOD_ALIASES.get(name, name)
    if name not in SS_METHODS:
        raise NodeError(f"内核不支持的加密方式：{method.strip()}")
    return name


def build_ss(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    """ss 链接有 SIP002 与旧式两种写法：

    - `ss://base64(method:password)@host:port?plugin=...#name`
    - `ss://base64(method:password@host:port)#name`

    共用凭据段让 urlparse 认不出来，所以这里自己切。
    """
    body = link.split("://", 1)[1].split("#", 1)[0]
    plugin_name, plugin_opts = "", ""
    if "?" in body:
        body, _, raw_query = body.partition("?")
        spec = parse_qs(raw_query, keep_blank_values=True).get("plugin", [""])[0]
        if spec:
            # SIP002 的 plugin 就是 `名字;选项=值;...`，与内核的 plugin/plugin_opts 同形。
            head, *rest = unquote(spec).split(";")
            plugin_name = head.strip()
            plugin_opts = ";".join(item for item in rest if item)
    if "@" in body:
        credentials, _, authority = body.rpartition("@")
        decoded = decode_base64(credentials) or unquote(credentials)
    else:
        decoded_full = decode_base64(body)
        if not decoded_full or "@" not in decoded_full:
            raise NodeError("ss 链接无法解码")
        decoded, _, authority = decoded_full.rpartition("@")
    method, _, password = decoded.partition(":")
    server, port = split_authority(authority)
    node: dict[str, Any] = {
        "type": "shadowsocks",
        "tag": tag,
        "server": server,
        "server_port": port,
        "method": normalize_ss_method(method),
        "password": password,
    }
    if plugin_name:
        node["plugin"] = plugin_name
        if plugin_opts:
            node["plugin_opts"] = plugin_opts
    return node


def build_trojan(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    password = raw_userinfo(parsed)
    if not password:
        raise NodeError("缺少密码")
    port, note = port_of(parsed)
    if note:
        notes.append(note)
    node: dict[str, Any] = {
        "type": "trojan",
        "tag": tag,
        "server": host_of(parsed),
        "server_port": port,
        "password": password,
    }
    transport = build_transport(pick(query, "type") or "", query)
    if transport:
        node["transport"] = transport
    # trojan 本身就靠 TLS 伪装，链接里不会有「关掉 TLS」的形式。
    node["tls"] = build_tls(query, server_name=transport_host(transport))
    return node


def build_hysteria2(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    """按官方 URI Scheme 解析：认证信息在 userinfo，端口缺省 443。"""
    password = raw_userinfo(parsed)
    if not password:
        raise NodeError("缺少密码")
    port, note = port_of(parsed, default=443)
    if note:
        notes.append(note)
    node: dict[str, Any] = {
        "type": "hysteria2",
        "tag": tag,
        "server": host_of(parsed),
        "server_port": port,
    }
    obfs = pick(query, "obfs")
    if obfs:
        obfs_password = pick(query, "obfs-password", "obfs_password", "obfsParam")
        if not obfs_password:
            # 内核要求混淆必须有密码，缺了就是一份跑不起来的配置。
            raise NodeError("混淆缺少密码")
        node["obfs"] = {"type": obfs, "password": obfs_password}
    node["password"] = password
    node["tls"] = build_tls(query)
    # 不补 ALPN：实测链接不带 alpn 时 hysteria2 一样能握手（内核自己处理），与 tuic 不同。
    if pick(query, "pinSHA256"):
        # 官方 scheme 的 pinSHA256 是证书指纹，内核只认公钥指纹，两者不能互换。
        notes.append("忽略 pinSHA256：内核只支持公钥指纹")
    return node


def build_tuic(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    uuid = username_of(parsed)
    if not uuid:
        raise NodeError("缺少 uuid")
    port, note = port_of(parsed)
    if note:
        notes.append(note)
    node: dict[str, Any] = {
        "type": "tuic",
        "tag": tag,
        "server": host_of(parsed),
        "server_port": port,
        "uuid": uuid,
    }
    node["password"] = password_of(parsed) or (pick(query, "password") or "")
    node["tls"] = build_tls(query)
    # 实测（沙箱内 loopback 握手）：TUIC 要客户端把 h3 报进 ALPN，内核不会自动补，
    # 链接里也不保证带 alpn，缺了就是 remote: tls: no application protocol。
    node["tls"].setdefault("alpn", ["h3"])
    congestion = pick(query, "congestion_control", "congestion")
    if congestion:
        if congestion in ("cubic", "new_reno", "bbr"):
            node["congestion_control"] = congestion
        else:
            notes.append(f"忽略未知的拥塞控制：{congestion}")
    mode = pick(query, "udp_relay_mode")
    if mode:
        if mode in ("native", "quic"):
            node["udp_relay_mode"] = mode
        else:
            notes.append(f"忽略未知的 UDP 中继模式：{mode}")
    return node


def build_anytls(
    link: str, parsed: ParseResult, query: dict[str, str], tag: str, notes: list[str]
) -> dict[str, Any]:
    password = pick(query, "auth") or raw_userinfo(parsed)
    if not password:
        raise NodeError("缺少密码")
    port, note = port_of(parsed)
    if note:
        notes.append(note)
    node: dict[str, Any] = {
        "type": "anytls",
        "tag": tag,
        "server": host_of(parsed),
        "server_port": port,
        "password": password,
        # anytls 就是 TLS 上的隧道，内核要求 tls.enabled。
        "tls": build_tls(query),
    }
    return node


BUILDERS: dict[str, Callable[..., dict[str, Any]]] = {
    "ss": build_ss,
    "vmess": build_vmess,
    "vless": build_vless,
    "trojan": build_trojan,
    "hysteria2": build_hysteria2,
    "hy2": build_hysteria2,
    "tuic": build_tuic,
    "anytls": build_anytls,
}


def node_tag(name: str, index: int, taken: set[str]) -> str:
    """节点 tag：取分享链接里的名字，重名或与分流 tag 撞名时加序号。

    名字只影响显示，但 tag 撞名会让整份配置校验失败，所以这里必须唯一。
    """
    base = re.sub(r"\s+", " ", name.strip()) or f"node-{index}"
    candidate = base
    suffix = 2
    while candidate in taken:
        candidate = f"{base}-{suffix}"
        suffix += 1
    taken.add(candidate)
    return candidate


def link_name(link: str, parsed: ParseResult) -> str:
    """分享链接里的节点名。

    普通链接把名字放在 fragment，vmess 没有 fragment，名字在内层 JSON 的 ps 里。
    """
    name = unquote(parsed.fragment or "")
    if name or not link.lower().startswith("vmess://"):
        return name
    text = decode_base64(link.split("://", 1)[1])
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return ""
    return str(payload.get("ps") or "") if isinstance(payload, dict) else ""


def parse_link(link: str, index: int, taken: set[str], notes: list[str]) -> dict[str, Any]:
    scheme = link.split("://", 1)[0].strip().lower()
    builder = BUILDERS.get(scheme)
    if builder is None:
        raise NodeError(f"不支持的协议：{scheme or link[:20]}")
    parsed = urlparse(link)
    tag = node_tag(link_name(link, parsed), index, taken)
    return builder(link, parsed, query_of(parsed), tag, notes)


def build_groups(
    node_tags: list[str], group_tags: list[str], main_group: str
) -> list[dict[str, Any]]:
    """按给定的 tag 列表生成分流分组。

    tag 列表由调用方给（生成器从规则清单的 policy 列取，公开层的 route.final 定主分组），
    模块本身不自带常量，免得和清单各改各的。

    成员一律是全部节点，站点分组默认跟随主分组：URL 里只有一个全局节点列表，没有
    「哪个站点走哪个节点」的输入。于是换节点只动主分组一处，想给某个站点钉死节点时，
    在那一组里直接选节点即可。
    """
    groups: list[dict[str, Any]] = [
        {
            "type": "selector",
            "tag": main_group,
            "outbounds": list(node_tags),
            "default": node_tags[0],
        }
    ]
    for tag in group_tags:
        if tag == main_group:
            continue
        groups.append(
            {
                "type": "selector",
                "tag": tag,
                "outbounds": [main_group, *node_tags],
                "default": main_group,
            }
        )
    return groups


def build_nodes(
    payload: dict[str, Any], *, reserved: frozenset[str] = frozenset()
) -> tuple[list[dict[str, Any]], list[str]]:
    """结构化输入 → 节点出站，以及逐条问题说明。不含分流分组。

    输入形如 `{"subscription": "<订阅体>", "nodes": ["<分享链接>", ...]}`；
    订阅体是 base64 还是明文由 parse_subscription 判断，两者产出一视同仁。

    reserved 里的 tag 留给调用方（生成分组时传全部分流 tag），节点名撞上时自动让位。
    """
    links: list[str] = []
    problems: list[str] = []
    subscription = str(payload.get("subscription") or "").strip()
    if subscription:
        found = parse_subscription(subscription)
        if not found:
            problems.append("订阅里没有可识别的节点链接")
        links.extend(found)
    for raw in payload.get("nodes") or []:
        if str(raw).strip():
            links.append(str(raw).strip())

    taken = set(reserved)
    outbounds: list[dict[str, Any]] = []
    for index, link in enumerate(links, 1):
        notes: list[str] = []
        try:
            outbounds.append(parse_link(link, index, taken, notes))
        except NodeError as error:
            problems.append(f"跳过第 {index} 个节点：{error}")
            continue
        problems.extend(f"第 {index} 个节点：{note}" for note in notes)

    if not outbounds:
        # 把逐条原因带出去：调用方（端点）要能告诉用户为什么一个节点都没用上。
        detail = "；".join(problems) if problems else "输入里没有节点"
        raise NodeError(f"没有可用节点（{detail}）")
    return outbounds, problems


def build_outbounds(
    payload: dict[str, Any], *, group_tags: list[str], main_group: str
) -> tuple[dict[str, Any], list[str]]:
    """节点出站 ＋ 分流分组，一次产出完整的一段配置。

    group_tags 是需要生成的出站 tag（公开层按这些名字引用），main_group 是其中的主分组。
    """
    if not group_tags:
        raise NodeError("没有给出任何分流 tag")
    if main_group not in group_tags:
        raise NodeError(f"主分组 {main_group} 不在分流 tag 列表里：{'、'.join(group_tags)}")

    nodes, problems = build_nodes(payload, reserved=frozenset(group_tags))
    tags = [node["tag"] for node in nodes]
    return {"outbounds": [*nodes, *build_groups(tags, group_tags, main_group)]}, problems
