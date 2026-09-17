from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NamedTuple


ROOT = Path(__file__).resolve().parent.parent
REMOTE_RULE_BASE = "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules"
DEFAULT_MANIFEST = ROOT / "config/rules/index.txt"
GENERATED_DIR = ROOT / "config/rules/generated"
SINGBOX_DIR = GENERATED_DIR / "singbox"
CLASH_DIR = GENERATED_DIR / "clash"
PLAIN_DIR = GENERATED_DIR / "plain"
UNSUPPORTED_DIR = GENERATED_DIR / "unsupported"
INDEX_PATH = GENERATED_DIR / "index.json"
ROUTESET_PATH = ROOT / "config/sing-box/conf.d/45-ruleset.json"
PUBLIC_TEMPLATE_PATH = ROOT / "config/sing-box/conf.d/10-public.json"
# 对外发布版：rule_set 指向发布分支的 URL，供不克隆本仓库的用户直接订阅
REMOTE_ROUTESET_PATH = GENERATED_DIR / "45-ruleset-remote.json"
SING_GEOIP_PREFIX = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set"
SING_GEOSITE_PREFIX = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set"

# rule_set.path 相对 sing-box 的工作目录解析。生产运行时工作目录是
# config/sing-box（justfile 的所有 sing-box 命令都从那一层启动）。
RULESET_RELATIVE_DIR = Path("../rules/generated/singbox")

# DNS 规则只能按查询名匹配，因此给 DNS 规则用的规则集产物只保留这几类字段。
DNS_RULE_FIELDS = ("domain", "domain_suffix", "domain_keyword", "domain_regex")
# DNS 规则专用的规则集产物名后缀：<tag>-dns。
DNS_RULESET_SUFFIX = "-dns"
# 内网域名规则集。公开层的 DNS 规则按这个名字引用它，所以它属于公开层的词汇表，
# 不是可以推导出来的值。
ZONE_RULESET_TAG = "zone-internal"
# 下载远端规则集用的 HTTP client 名。
RULESET_CLIENT_TAG = "rule-set-dl"

SUPPORTED_FIELDS = {
    "DOMAIN": "domain",
    "DOMAIN-SUFFIX": "domain_suffix",
    "DOMAIN-KEYWORD": "domain_keyword",
    "DOMAIN-REGEX": "domain_regex",
    "IP-CIDR": "ip_cidr",
    "IP-CIDR6": "ip_cidr",
    "SRC-IP-CIDR": "source_ip_cidr",
    "SRC-PORT": "source_port",
    "DST-PORT": "port",
    "DEST-PORT": "port",
    "PORT": "port",
    "PROCESS-NAME": "process_name",
    "NETWORK": "network",
}

# sing-box 的路由规则没有对应表达，一律跳过并记录。
# USER-AGENT / URL-REGEX：单靠 TLS 嗅探拿不到，sing-box 不暴露这两个维度。
# IP-ASN / SRC-GEOIP / SRC-IP-ASN：geoip 族匹配已在 sing-box 1.12.0 移除，
#   且源侧没有等价的行内表达，只能跳过。
# IN-PORT：sing-box 用 inbound tag 而不是端口号来区分入口。
# PROTOCOL：Loon 的取值是 TCP/UDP/QUIC/HTTP，与 sing-box 的 protocol（嗅探协议）
#           和 network（tcp/udp）两套语义交叉，无法一一映射，宁可跳过也不猜。
#
# 注意 GEOIP / GEOSITE 不在此列：它们会被 normalize 成对 sing-geoip /
# sing-geosite 预编译规则集的引用（见 special_ref_to_url），不是丢弃。
UNSUPPORTED_TYPES = {
    "USER-AGENT",
    "URL-REGEX",
    "IP-ASN",
    "SRC-GEOIP",
    "SRC-IP-ASN",
    "IN-PORT",
    "PROTOCOL",
}

# mihomo 的 rule-provider（behavior: classical）能原生吃下这些行。
# 详见 https://wiki.metacubex.one/en/config/rules/
CLASH_SUPPORTED = set(SUPPORTED_FIELDS) | {
    "IP-ASN",
    "GEOIP",
    "GEOSITE",
    "SRC-GEOIP",
    "SRC-IP-ASN",
    "SRC-IP-SUFFIX",
    "IP-SUFFIX",
    "AND",
    "OR",
    "NOT",
}

# Loon 用 DEST-PORT，mihomo 用 DST-PORT，同一语义两种拼写。
CLASH_RENAMES = {"DEST-PORT": "DST-PORT"}

# 路由策略的优先级顺序来自 config/rules/policy-order.txt（数据，不是代码）：
# 顺序是使用者的偏好，改顺序不该改代码。
DEFAULT_POLICY_ORDER_PATH = ROOT / "config/rules/policy-order.txt"
# reject 不是出站：它编译成 action: reject，所以这个名字是语义，不是可推导的值。
REJECT_POLICY = "reject"

LOGICAL_PREFIXES = ("AND,", "OR,", "NOT,")


@dataclass(frozen=True)
class RemoteList:
    tag: str
    policy: str
    source: str
    origin: str = "manifest"

    @property
    def output_name(self) -> str:
        """产物文件名。tag 即产物名，不再从 URL 派生。

        从客户端配置反推清单时（extract 子命令），tag 来自 URL 文件名或 provider
        名，可能含路径分隔符等字符，因此这里做一次净化。
        """
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", self.tag).strip("_")
        return safe or "rule"

    @property
    def is_remote(self) -> bool:
        return self.source.startswith(("http://", "https://"))


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def clean_generated_outputs() -> None:
    if GENERATED_DIR.exists():
        for path in sorted(GENERATED_DIR.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            elif path.is_dir():
                path.rmdir()
    if ROUTESET_PATH.exists():
        ROUTESET_PATH.unlink()


def fetch_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "singbox-rule-builder/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8")


def fetch_bytes(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "singbox-rule-builder/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def read_source(source: str) -> str:
    """source 为 http(s) URL 时联网拉取，否则按仓库相对路径读取本地文件。"""
    if source.startswith(("http://", "https://")):
        return fetch_text(source)
    path = ROOT / source
    if not path.is_file():
        raise FileNotFoundError(f"rule source not found: {source}")
    return read_text(path)


def load_manifest(path: Path) -> list[RemoteList]:
    items: list[RemoteList] = []
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split("|")
        if len(parts) != 3:
            raise ValueError(f"invalid manifest line (want tag|policy|source): {line}")
        tag, policy, source = [part.strip() for part in parts]
        if not tag or not policy or not source:
            raise ValueError(f"empty manifest field: {line}")
        items.append(RemoteList(tag=tag, policy=policy, source=source, origin="manifest"))
    return items


def parse_payload_yaml(lines: list[str]) -> list[str]:
    in_payload = False
    payload: list[str] = []
    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "payload:":
            in_payload = True
            continue
        if not in_payload:
            continue
        if raw_line.lstrip().startswith("- "):
            item = raw_line.lstrip()[2:].strip().strip("'\"")
            payload.append(item)
            continue
        if not raw_line.startswith(" "):
            break
    return payload


def normalize_rule_lines(text: str) -> list[str]:
    raw_lines = text.splitlines()
    first_non_comment = next(
        (
            line.strip()
            for line in raw_lines
            if line.strip() and not line.strip().startswith("#")
        ),
        "",
    )
    if first_non_comment == "payload:":
        return parse_payload_yaml(raw_lines)
    lines: list[str] = []
    for raw_line in raw_lines:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(stripped)
    return lines


def append_value(store: dict[str, dict[str, None]], field: str, value: str) -> None:
    store[field][value] = None


def strip_outer_parens(text: str) -> str:
    stripped = text.strip()
    if not (stripped.startswith("(") and stripped.endswith(")")):
        return stripped
    depth = 0
    for index, char in enumerate(stripped):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0 and index != len(stripped) - 1:
                return stripped
    return stripped[1:-1].strip()


def split_top_level(text: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    for char in text:
        if char == "," and depth == 0:
            part = "".join(current).strip()
            if part:
                parts.append(part)
            current = []
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        current.append(char)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def classify_simple_rule(line: str) -> tuple[str, Any]:
    stripped = line.strip()
    if "," not in stripped:
        if stripped.startswith("."):
            return "rule", ("domain_suffix", stripped[1:])
        return "rule", ("domain", stripped)

    parts = [part.strip() for part in stripped.split(",")]
    if len(parts) < 2:
        return "unsupported", stripped
    rule_type = parts[0].upper()
    value = parts[1]

    if rule_type in {"GEOIP", "GEOSITE"}:
        return "special", {
            "kind": rule_type.lower(),
            "value": value.lower(),
            "raw": stripped,
        }

    if rule_type in UNSUPPORTED_TYPES:
        return "unsupported", stripped

    field = SUPPORTED_FIELDS.get(rule_type)
    if not field:
        return "unsupported", stripped

    if field in {"port", "source_port"}:
        try:
            return "rule", (field, int(value))
        except ValueError:
            return "unsupported", stripped

    return "rule", (field, value)


def make_leaf_rule(line: str) -> tuple[dict[str, Any] | None, str | None]:
    kind, payload = classify_simple_rule(line)
    if kind != "rule":
        return None, line
    field, value = payload
    return {field: [value]}, None


def parse_logical_rule(line: str) -> tuple[dict[str, Any] | None, list[str]]:
    rule_type, rest = line.split(",", 1)
    op = rule_type.upper()
    unsupported: list[str] = []
    inner = strip_outer_parens(rest)
    parts = split_top_level(inner)
    if op in {"AND", "OR"}:
        child_rules: list[dict[str, Any]] = []
        for part in parts:
            child, child_unsupported = parse_rule_expression(strip_outer_parens(part))
            unsupported.extend(child_unsupported)
            if child is None:
                unsupported.append(line)
                return None, sorted(set(unsupported))
            child_rules.append(child)
        return {
            "type": "logical",
            "mode": op.lower(),
            "rules": child_rules,
        }, sorted(set(unsupported))

    if op == "NOT" and len(parts) == 1:
        child, child_unsupported = parse_rule_expression(strip_outer_parens(parts[0]))
        unsupported.extend(child_unsupported)
        if child is None:
            unsupported.append(line)
            return None, sorted(set(unsupported))
        inverted = dict(child)
        inverted["invert"] = True
        return inverted, sorted(set(unsupported))

    return None, [line]


def parse_rule_expression(line: str) -> tuple[dict[str, Any] | None, list[str]]:
    stripped = line.strip()
    upper = stripped.upper()
    if upper.startswith(("AND,", "OR,", "NOT,")):
        return parse_logical_rule(stripped)
    leaf, unsupported = make_leaf_rule(stripped)
    if unsupported:
        return None, [unsupported]
    return leaf, []


def special_ref_to_url(kind: str, value: str) -> str:
    suffix = f"{kind}-{value}.srs"
    if kind == "geoip":
        return f"{SING_GEOIP_PREFIX}/{suffix}"
    return f"{SING_GEOSITE_PREFIX}/{suffix}"


def special_ref_to_metadata(special_refs: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "version": 1,
        "kind": "external_rule_set",
        "references": [
            {
                "type": ref["kind"],
                "value": ref["value"],
                "tag": f"{ref['kind']}-{ref['value']}",
                "url": special_ref_to_url(ref["kind"], ref["value"]),
            }
            for ref in special_refs
        ],
    }


def convert_rule_lines(
    rule_lines: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[str]]:
    grouped: dict[str, dict[str, None]] = defaultdict(dict)
    logical_rules: list[dict[str, Any]] = []
    special_refs: list[dict[str, str]] = []
    unsupported: list[str] = []

    for line in rule_lines:
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith(("AND,", "OR,", "NOT,")):
            logical_rule, logical_unsupported = parse_logical_rule(stripped)
            if logical_rule is not None:
                logical_rules.append(logical_rule)
            unsupported.extend(logical_unsupported)
            continue

        kind, payload = classify_simple_rule(stripped)
        if kind == "unsupported":
            unsupported.append(stripped)
            continue
        if kind == "special":
            special_refs.append(payload)
            continue

        field, value = payload
        append_value(grouped, field, str(value))

    rules: list[dict[str, Any]] = []
    for field, values in grouped.items():
        if field in {"port", "source_port"}:
            rules.append({field: [int(value) for value in values.keys()]})
        else:
            rules.append({field: list(values.keys())})
    rules.extend(logical_rules)
    return rules, special_refs, sorted(set(unsupported))


def to_source_json(rules: list[dict[str, Any]]) -> dict[str, Any]:
    ordered_rules: list[dict[str, Any]] = []
    field_order = [
        "domain",
        "domain_suffix",
        "domain_keyword",
        "domain_regex",
        "process_name",
        "ip_cidr",
        "source_ip_cidr",
        "port",
        "source_port",
        "network",
    ]
    for field in field_order:
        ordered_rules.extend(
            [rule for rule in rules if field in rule and rule.get("type") != "logical"]
        )
    ordered_rules.extend([rule for rule in rules if rule.get("type") == "logical"])
    return {"version": 3, "rules": ordered_rules}


def ensure_sing_box() -> str:
    command = shutil.which("sing-box")
    if command:
        return command
    override = Path.home() / ".local/share/mise/installs/sing-box"
    if override.is_dir():
        for version in sorted(override.iterdir(), reverse=True):
            candidate = version / "sing-box"
            if candidate.is_file():
                return str(candidate)
    raise RuntimeError("sing-box not found")


def compile_srs(source_path: Path, output_path: Path) -> None:
    sing_box = ensure_sing_box()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sing_box,
            "rule-set",
            "compile",
            "--output",
            str(output_path),
            str(source_path),
        ],
        check=True,
    )


def download_special_srs(special_refs: list[dict[str, str]], output_path: Path) -> None:
    if len(special_refs) != 1:
        raise RuntimeError("mixed or multiple GEOIP/GEOSITE refs are not supported yet")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    ref = special_refs[0]
    output_path.write_bytes(fetch_bytes(special_ref_to_url(ref["kind"], ref["value"])))


class Emission(NamedTuple):
    """一次客户端产物生成的完整结果。"""

    text: str
    skipped: list[str]
    special_refs: list[dict[str, str]] = []


def emit_singbox(rule_lines: list[str]) -> Emission:
    """输出 sing-box 源规则集 JSON 文本，附带被跳过的原始行。

    GEOIP / GEOSITE 行没有行内等价，但当整个列表只有这类引用时，可以退化为
    对 sing-geoip / sing-geosite 预编译规则集的引用（special_refs），此时产物
    是下载来的 .srs，而不是本地编译的。
    """
    rules, special_refs, unsupported = convert_rule_lines(rule_lines)
    if special_refs and not rules and not unsupported:
        payload = special_ref_to_metadata(special_refs)
        return Emission(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", [], special_refs
        )
    payload = to_source_json(rules)
    return Emission(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", unsupported)


def emit_singbox_dns(rule_lines: list[str], *, label: str = "") -> Emission:
    """同一份源规则里只保留按查询名匹配的字段，产出 DNS 规则专用的规则集。

    DNS 规则在拿到响应之前只能按查询名判定，IP 类条目在 DNS 规则里没有可判定的语义：
    内核 1.14 起把这类引用标为废弃、1.16 起移除
    （见 https://sing-box.sagernet.org/migration/#migrate-address-filter-fields-to-response-matching）。
    所以公开层里被 DNS 规则引用的列表要有一份域名版。
    """
    emission = emit_singbox(rule_lines)
    payload = json.loads(emission.text)
    kept: list[dict[str, Any]] = []
    for rule in payload.get("rules") or []:
        domain_fields = {key: value for key, value in rule.items() if key in DNS_RULE_FIELDS}
        if domain_fields:
            kept.append(domain_fields)
    if not kept:
        # 一份没有域名条目的列表当 DNS 规则用，只会把那套废弃写法再抄一遍，宁可构建失败。
        raise RuntimeError(
            f"{label or '规则集'}里没有域名类条目，生成不出 DNS 规则用的规则集"
        )
    return Emission(
        json.dumps(to_source_json(kept), ensure_ascii=False, indent=2) + "\n",
        emission.skipped,
    )


def clash_rule_line(stripped: str) -> str | None:
    """把一行源规则转成 mihomo classical provider 的行，无法表达时返回 None。

    `.domain.com` 是 DOMAIN-SUFFIX 的省略写法，裸域名是 DOMAIN 的省略写法；
    这两种在 Surge/Loon 的列表里很常见（如 Apple_Domain.list），但 provider
    的 payload 里没有省略语法，必须还原成完整规则。
    """
    if "," not in stripped:
        if stripped.startswith("."):
            return f"DOMAIN-SUFFIX,{stripped[1:]}"
        return f"DOMAIN,{stripped}"
    rule_type = stripped.split(",", 1)[0].strip().upper()
    if rule_type not in CLASH_SUPPORTED:
        return None
    renamed = CLASH_RENAMES.get(rule_type, rule_type)
    return renamed + stripped[len(rule_type) :]


def emit_clash(rule_lines: list[str]) -> Emission:
    """输出 mihomo rule-provider 的 payload 文本。

    behavior: classical 的 provider 逐行吃原生规则语法，因此这里只做重命名、
    省略式还原与过滤，不改变规则语义。
    详见 https://wiki.metacubex.one/en/config/rule-providers/
    """
    kept: list[str] = []
    skipped: list[str] = []
    for line in rule_lines:
        stripped = line.strip()
        if not stripped:
            continue
        converted = clash_rule_line(stripped)
        if converted is None:
            skipped.append(stripped)
            continue
        kept.append(converted)
    body = "\n".join(f"  - '{line}'" for line in kept)
    text = f"payload:\n{body}\n" if kept else "payload: []\n"
    return Emission(text, skipped)


def emit_plain(rule_lines: list[str]) -> Emission:
    """内容行原样输出，不做类型过滤或改写。

    Loon 与 Surge 的规则集行格式与源格式一致，所以不需要转换。
    注释与空行已在上游 normalize_rule_lines 里去掉了，这里拿到的是纯规则行。
    """
    return Emission("\n".join(rule_lines) + "\n", [])


CLIENT_EMITTERS = {
    "singbox": emit_singbox,
    "clash": emit_clash,
    "plain": emit_plain,
}


def find_item(items: list[RemoteList], target: str) -> RemoteList:
    normalized = target.lower()
    for item in items:
        if item.tag.lower() == normalized or item.output_name.lower() == normalized:
            return item
    raise KeyError(f"tag not found: {target}")


def routeset_entry(name: str, *, remote: bool) -> dict[str, Any]:
    """一条 rule_set 声明。远端形态给设备用，本地形态给本机跑磁盘产物用。"""
    if remote:
        return {
            "type": "remote",
            "tag": name,
            "format": "binary",
            "url": f"{REMOTE_RULE_BASE}/singbox/{name}.srs",
            # 默认也是 1d，写出来是为了不依赖「没说就是 1d」这条隐式规则。
            "update_interval": "1d",
        }
    return {
        "type": "local",
        "tag": name,
        "format": "binary",
        "path": f"{RULESET_RELATIVE_DIR.as_posix()}/{name}.srs",
    }


def build_routeset(
    items: list[RemoteList],
    policy_order: list[str],
    *,
    remote: bool = False,
    companion_names: list[str] | None = None,
) -> dict[str, Any]:
    """生成路由片段：声明全部 rule_set 并按 policy 分组下发路由。

    顺序即优先级：sing-box 合并同目录配置时按文件名排序并追加数组，登记排在手写的公开层
    之后，因此手写的 zone-internal 规则恒在列表规则之前。

    policy_order 决定各 policy 之间的先后（来自 policy-order.txt）；不在表里的 policy
    按字母序排在后面，不丢。

    remote=False 供本仓库自用，指向磁盘上的生成产物（相对工作目录）。
    remote=True 供外部用户订阅，指向已发布分支上的 URL。

    companion_names 是 DNS 规则专用的域名版规则集：它们只被 DNS 规则引用，不参与路由，
    所以只声明、不生成路由规则。
    """
    by_policy: dict[str, list[str]] = defaultdict(list)
    for item in items:
        by_policy[item.policy].append(item.tag)

    ordered = [p for p in policy_order if p in by_policy]
    ordered += sorted(p for p in by_policy if p not in policy_order)

    rules: list[dict[str, Any]] = []
    for policy in ordered:
        tags = sorted(by_policy[policy])
        if policy == REJECT_POLICY:
            rules.append({"rule_set": tags, "action": "reject"})
        else:
            rules.append(
                {"rule_set": tags, "action": "route", "outbound": policy}
            )

    declared = [
        routeset_entry(item.output_name, remote=remote)
        for item in sorted(items, key=lambda x: x.output_name)
    ]
    declared += [
        routeset_entry(name, remote=remote) for name in companion_names or []
    ]

    return {"route": {"rule_set": declared, "rules": rules}}


def build_index(items: list[RemoteList]) -> dict[str, Any]:
    entries = []
    for item in items:
        name = item.output_name
        entries.append(
            {
                "tag": item.tag,
                "policy": item.policy,
                "source": item.source,
                "output_name": name,
                "local_source": not item.is_remote,
                "paths": {
                    client: f"config/rules/generated/{client}/{name}{suffix}"
                    for client, suffix in (
                        ("singbox", ".json"),
                        ("clash", ".yaml"),
                        ("plain", ".list"),
                    )
                },
                "remote_urls": {
                    client: f"{REMOTE_RULE_BASE}/{client}/{name}{suffix}"
                    for client, suffix in (
                        ("singbox", ".json"),
                        ("clash", ".yaml"),
                        ("plain", ".list"),
                    )
                },
            }
        )
    return {"version": 2, "entries": entries}


def write_index(items: list[RemoteList]) -> None:
    write_text(
        INDEX_PATH, json.dumps(build_index(items), ensure_ascii=False, indent=2) + "\n"
    )


def write_routeset(items: list[RemoteList], policy_order: list[str]) -> None:
    """写两份路由片段。

    本仓库自用的一份指向磁盘产物，配 conf.d 下的其他文件一起跑。
    对外订阅的一份指向发布分支的 URL，给不克隆本仓库的用户直接用。
    """
    # sing-box 合并同目录配置时按文件名排序，命令行传入的先后无效（实测）。手写公开层
    # 必须排在生成的登记之前：登记里的列表规则若先命中，内网直连规则就永远不会生效。
    # 文件名一改顺序就会静默翻转，所以在这里先拦住。
    if PUBLIC_TEMPLATE_PATH.name > ROUTESET_PATH.name:
        raise RuntimeError(
            "public template must sort before the rule-set registry, "
            f"got {PUBLIC_TEMPLATE_PATH.name} > {ROUTESET_PATH.name}"
        )
    companion_names = dns_companion_names(load_template(), items)
    for path, remote in ((ROUTESET_PATH, False), (REMOTE_ROUTESET_PATH, True)):
        write_text(
            path,
            json.dumps(
                build_routeset(
                    items,
                    policy_order,
                    remote=remote,
                    companion_names=companion_names,
                ),
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )


SUFFIXES = {"singbox": ".json", "clash": ".yaml", "plain": ".list"}


def build_one(
    item: RemoteList, *, dns_companion: bool = False
) -> list[tuple[str, Path, int, int]]:
    """为单个 tag 生成全部客户端产物，返回 (client, 路径, 源行数, 跳过数)。

    dns_companion 为真时额外产出一份只含域名条目的副本，给 DNS 规则用。
    """
    content = read_source(item.source)
    rule_lines = normalize_rule_lines(content)
    results: list[tuple[str, Path, int, int]] = []

    for client, emitter in CLIENT_EMITTERS.items():
        emission = emitter(rule_lines)
        path = GENERATED_DIR / client / f"{item.output_name}{SUFFIXES[client]}"
        write_text(path, emission.text)

        if client == "singbox" and emission.special_refs:
            # 纯 GEOIP/GEOSITE 列表：产物直接是上游预编译的规则集。
            download_special_srs(emission.special_refs, path.with_suffix(".srs"))
        elif client == "singbox":
            compile_srs(path, path.with_suffix(".srs"))

        report = UNSUPPORTED_DIR / client / f"{item.output_name}.txt"
        skipped = emission.skipped
        if skipped:
            write_text(report, "\n".join(skipped) + "\n")
        elif report.exists():
            report.unlink()

        results.append((client, path, len(rule_lines), len(skipped)))

    if dns_companion:
        dns_emission = emit_singbox_dns(rule_lines, label=item.tag)
        dns_path = SINGBOX_DIR / f"{dns_ruleset_name(item.output_name)}.json"
        write_text(dns_path, dns_emission.text)
        compile_srs(dns_path, dns_path.with_suffix(".srs"))
        results.append(("singbox", dns_path, len(rule_lines), 0))
    return results


def cmd_convert(args: argparse.Namespace) -> int:
    """纯转换，不联网、不写仓库目录。供测试驱动。"""
    raw = sys.stdin.read() if args.input == "-" else read_text(Path(args.input))
    lines = normalize_rule_lines(raw)
    if args.dns_only:
        # 域名版产物只对 sing-box 有意义：DNS 规则是它的概念。
        if args.client != "singbox":
            print("error: --dns-only 只对 singbox 客户端有意义", file=sys.stderr)
            return 1
        emission = emit_singbox_dns(lines)
    else:
        emission = CLIENT_EMITTERS[args.client](lines)
    if args.output == "-":
        sys.stdout.write(emission.text)
    else:
        write_text(Path(args.output), emission.text)
    if emission.skipped and args.report:
        write_text(Path(args.report), "\n".join(emission.skipped) + "\n")
    print(f"client={args.client} skipped={len(emission.skipped)}", file=sys.stderr)
    return 0


def load_policy_order(path: Path) -> list[str]:
    """读策略优先级顺序：一行一个 policy，`#` 开头是注释。"""
    if not path.is_file():
        raise RuntimeError(f"找不到策略顺序文件：{path}")
    lines = [line.strip() for line in read_text(path).splitlines()]
    return [line for line in lines if line and not line.startswith("#")]


def load_template() -> dict[str, Any]:
    return json.loads(read_text(PUBLIC_TEMPLATE_PATH))


def dns_ruleset_name(name: str) -> str:
    """DNS 规则专用规则集的产物名。"""
    return name + DNS_RULESET_SUFFIX


def dns_companion_names(template: dict[str, Any], items: list[RemoteList]) -> list[str]:
    """需要额外产出一份「只含域名条目」副本的产物名。

    公开层的 DNS 规则引用到的清单 tag 都要有域名版：DNS 规则里不能引用含 IP 条目的规则集
    （内核 1.14 起废弃、1.16 移除）。公开层自己内联声明的（zone-internal）不需要。
    """
    inline = {
        str(entry.get("tag"))
        for entry in (template.get("route") or {}).get("rule_set") or []
        if isinstance(entry, dict) and entry.get("tag")
    }
    # zone-internal 由 config/sing-box/template.json 内联声明（它带内网域名后缀），不是清单产物。
    inline.add(ZONE_RULESET_TAG)
    by_output: dict[str, RemoteList] = {}
    for item in items:
        by_output[item.output_name] = item
        by_output.setdefault(item.tag, item)

    names: list[str] = []
    for rule in (template.get("dns") or {}).get("rules") or []:
        referenced = rule.get("rule_set")
        for tag in ([referenced] if isinstance(referenced, str) else list(referenced or [])):
            tag = str(tag)
            if tag in inline or tag in names:
                continue
            # 公开层可以引用清单 tag 本身，也可以引用它的域名版；两种写法都要认得出对应产物。
            base = tag[: -len(DNS_RULESET_SUFFIX)] if tag.endswith(DNS_RULESET_SUFFIX) else tag
            if base not in by_output:
                raise RuntimeError(
                    "公开层的 DNS 规则引用了既不在清单里、也不是内联声明的规则集：" + tag
                )
            names.append(dns_ruleset_name(base))
    return names


def cmd_build(args: argparse.Namespace) -> int:
    items = load_manifest(Path(args.manifest))
    policy_order = load_policy_order(Path(args.policy_order))
    # 没排过序的策略不会丢，只是按字母序排在已排的之后；这里说清楚是哪几个。
    unlisted = sorted({item.policy for item in items} - set(policy_order))
    if unlisted:
        print(
            "note: 策略顺序文件里没有这些 policy，按字母序排在后面："
            + ", ".join(unlisted)
        )
    if args.all:
        clean_generated_outputs()
        write_index(items)
        write_routeset(items, policy_order)
    targets = items if args.all else [find_item(items, args.tag)]
    companions = set(dns_companion_names(load_template(), items))
    totals: dict[str, int] = defaultdict(int)

    for item in targets:
        results = build_one(
            item, dns_companion=dns_ruleset_name(item.output_name) in companions
        )
        parts = []
        for client, path, total, skipped in results:
            totals[client] += skipped
            parts.append(f"{client}={total - skipped}/{total}")
        print(
            f"built {item.tag} -> {', '.join(parts)}, "
            f"policy={item.policy}, name={item.output_name}"
        )

    # 有跳过项的 tag 才写报告，这里汇总列出，便于人工核对。
    reports = sorted(p for p in UNSUPPORTED_DIR.rglob("*.txt") if p.is_file())
    if reports:
        print(f"skipped reports ({len(reports)}):")
        for path in reports:
            print(f"  {path.relative_to(ROOT)}")
    summary = ", ".join(f"{c} skipped={totals[c]}" for c in CLIENT_EMITTERS)
    print(f"done: built={len(targets)}, {summary}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    build_parser_cmd = subparsers.add_parser("build")
    build_group = build_parser_cmd.add_mutually_exclusive_group(required=True)
    build_group.add_argument("tag", nargs="?")
    build_group.add_argument("--all", action="store_true")
    build_parser_cmd.add_argument(
        "--manifest",
        default=str(DEFAULT_MANIFEST),
    )
    build_parser_cmd.add_argument(
        "--policy-order",
        default=str(DEFAULT_POLICY_ORDER_PATH),
        help="策略优先级顺序文件",
    )
    build_parser_cmd.set_defaults(func=cmd_build)

    convert_parser = subparsers.add_parser("convert")
    convert_parser.add_argument("--input", required=True, help="file or - for stdin")
    convert_parser.add_argument(
        "--client", required=True, choices=sorted(CLIENT_EMITTERS)
    )
    convert_parser.add_argument(
        "--output", default="-", help="file or - for stdout"
    )
    convert_parser.add_argument(
        "--report", help="write skipped lines to this file"
    )
    convert_parser.add_argument(
        "--dns-only",
        action="store_true",
        help="只保留按查询名匹配的字段，供 DNS 规则使用",
    )
    convert_parser.set_defaults(func=cmd_convert)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
