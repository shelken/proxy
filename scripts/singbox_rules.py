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
DEFAULT_LOON_CONFIG = ROOT / "config/loon/mac.conf"
DEFAULT_MANIFEST = ROOT / "config/rules/index.txt"
DEFAULT_PROFILE_PATH = ROOT / "config/sing-box/meta/generated/loon-profile.json"
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

# 路由策略顺序即优先级，先匹配先胜。见 build_routeset。
POLICY_ORDER = [
    "reject",
    "gemini",
    "openai",
    "appleai",
    "opencode",
    "dev",
    "ptcg",
    "japansite",
    "adultnsfw",
    "direct",
    "proxy",
]
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


def parse_key_values(parts: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for part in parts:
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        result[key.strip()] = value.strip()
    return result


def parse_assignment_line(raw_line: str) -> tuple[str, list[str]]:
    if "=" not in raw_line:
        raise ValueError(f"invalid assignment line: {raw_line}")
    left, right = raw_line.split("=", 1)
    name = left.strip()
    parts = [part.strip() for part in right.split(",")]
    return name, parts


def extract_section_lines(text: str, section_name: str) -> list[str]:
    lines = text.splitlines()
    in_section = False
    items: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if line.startswith("[") and line.endswith("]"):
            in_section = line == section_name
            continue
        if not in_section or not line or line.startswith("#"):
            continue
        items.append(raw_line.strip())
    return items


def strip_wrapped_quotes(value: str) -> str:
    stripped = value.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in {'"', "'"}:
        return stripped[1:-1]
    return stripped


def parse_loon_remote_filters(text: str) -> list[dict[str, str]]:
    filters: list[dict[str, str]] = []
    for raw_line in extract_section_lines(text, "[Remote Filter]"):
        tag, parts = parse_assignment_line(raw_line)
        if not parts:
            continue
        filter_type = parts[0]
        attrs = parse_key_values(parts[1:])
        filters.append(
            {
                "tag": tag,
                "type": filter_type,
                "filter_key": strip_wrapped_quotes(attrs.get("FilterKey", "")),
            }
        )
    return filters


def parse_loon_proxy_groups(text: str) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for raw_line in extract_section_lines(text, "[Proxy Group]"):
        tag, parts = parse_assignment_line(raw_line)
        if not parts:
            continue
        group_type = parts[0]
        members: list[str] = []
        attributes: dict[str, str] = {}
        for part in parts[1:]:
            if "=" in part:
                key, value = part.split("=", 1)
                attributes[key.strip()] = value.strip()
                continue
            members.append(part)
        groups.append(
            {
                "tag": tag,
                "type": group_type,
                "members": members,
                "attributes": attributes,
            }
        )
    return groups


def classify_group_member(
    member: str,
    group_tags: set[str],
    filter_tags: set[str],
) -> dict[str, str]:
    if member in {"DIRECT", "REJECT"}:
        return {"type": "builtin", "name": member}
    if member in filter_tags:
        return {"type": "filter", "name": member}
    if member in group_tags:
        return {"type": "group", "name": member}
    return {"type": "outbound", "name": member}


def build_loon_profile(text: str) -> dict[str, Any]:
    filters = parse_loon_remote_filters(text)
    groups = parse_loon_proxy_groups(text)
    group_tags = {group["tag"] for group in groups}
    filter_tags = {filter_item["tag"] for filter_item in filters}
    resolved_groups: list[dict[str, Any]] = []
    for group in groups:
        resolved_groups.append(
            {
                "tag": group["tag"],
                "type": group["type"],
                "members": [
                    classify_group_member(member, group_tags, filter_tags)
                    for member in group["members"]
                ],
                "attributes": group["attributes"],
            }
        )
    return {
        "version": 1,
        "source": "loon",
        "filters": filters,
        "groups": resolved_groups,
    }


def cmd_extract_profile(args: argparse.Namespace) -> int:
    text = read_text(Path(args.input))
    profile = build_loon_profile(text)
    write_text(
        Path(args.output),
        json.dumps(profile, ensure_ascii=False, indent=2) + "\n",
    )
    print(
        f"profile: {args.output} "
        f"(filters={len(profile['filters'])}, groups={len(profile['groups'])})"
    )
    return 0


def parse_loon_remote_rules(text: str) -> list[RemoteList]:
    lines = text.splitlines()
    in_section = False
    items: list[RemoteList] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("[") and line.endswith("]"):
            in_section = line == "[Remote Rule]"
            continue
        if not in_section or line.startswith("#"):
            continue
        parts = [part.strip() for part in raw_line.split(",")]
        url = parts[0].strip()
        meta = parse_key_values(parts[1:])
        if meta.get("enabled", "true").lower() != "true":
            continue
        tag = meta.get("tag") or Path(url).stem
        policy = meta.get("policy", "DIRECT")
        items.append(
            RemoteList(tag=tag, policy=policy, source=url, origin="loon")
        )
    return items


def parse_clash_remote_rules(text: str) -> list[RemoteList]:
    providers: dict[str, dict[str, str]] = {}
    provider_name: str | None = None
    in_rule_providers = False
    in_rules = False
    references: dict[str, str] = {}

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        stripped = raw_line.strip()

        if indent == 0 and stripped == "rule-providers:":
            in_rule_providers = True
            in_rules = False
            provider_name = None
            continue
        if indent == 0 and stripped == "rules:":
            in_rules = True
            in_rule_providers = False
            provider_name = None
            continue
        if indent == 0 and stripped.endswith(":"):
            in_rule_providers = False
            in_rules = False
            provider_name = None
            continue

        if in_rule_providers:
            if indent == 2 and stripped.endswith(":"):
                provider_name = stripped[:-1].strip()
                providers.setdefault(provider_name, {})
                continue
            if provider_name and indent >= 4 and ":" in stripped:
                key, value = stripped.split(":", 1)
                providers[provider_name][key.strip()] = value.strip().strip("'\"")
            continue

        if in_rules and stripped.startswith("- "):
            rule_body = stripped[2:].strip().strip("'\"")
            parts = [part.strip() for part in rule_body.split(",")]
            if len(parts) < 3:
                continue
            if parts[0].upper() != "RULE-SET":
                continue
            references[parts[1]] = parts[2]

    items: list[RemoteList] = []
    for provider, policy in references.items():
        meta = providers.get(provider)
        if not meta:
            continue
        url = meta.get("url")
        if not url:
            continue
        items.append(
            RemoteList(tag=provider, policy=policy, source=url, origin="clash")
        )
    return items


def extract_remote_rules(path: Path) -> list[RemoteList]:
    text = read_text(path)
    if "[Remote Rule]" in text:
        return parse_loon_remote_rules(text)
    if "rule-providers:" in text and "rules:" in text:
        return parse_clash_remote_rules(text)
    raise ValueError(f"unsupported config format: {path}")


def render_manifest(items: list[RemoteList]) -> str:
    lines = ["# tag|policy|source"]
    unique = {(item.tag, item.policy, item.source): item for item in items}
    for item in sorted(unique.values(), key=lambda x: (x.tag.lower(), x.source)):
        lines.append(f"{item.tag}|{item.policy}|{item.source}")
    lines.append("")
    return "\n".join(lines)


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
    if not command:
        raise RuntimeError("sing-box not found")
    return command


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


def build_routeset(items: list[RemoteList], *, remote: bool = False) -> dict[str, Any]:
    """生成路由片段：声明全部 rule_set 并按 policy 分组下发路由。

    顺序即优先级：sing-box 合并同目录配置时按文件名排序并追加数组，登记排在手写的公开层
    之后，因此手写的 zone-internal 规则恒在列表规则之前。

    remote=False 供本仓库自用，指向磁盘上的生成产物（相对工作目录）。
    remote=True 供外部用户订阅，指向已发布分支上的 URL。
    """
    by_policy: dict[str, list[str]] = defaultdict(list)
    for item in items:
        by_policy[item.policy].append(item.tag)

    ordered = [p for p in POLICY_ORDER if p in by_policy]
    ordered += sorted(p for p in by_policy if p not in POLICY_ORDER)

    rules: list[dict[str, Any]] = []
    for policy in ordered:
        tags = sorted(by_policy[policy])
        if policy == REJECT_POLICY:
            rules.append({"rule_set": tags, "action": "reject"})
        else:
            rules.append(
                {"rule_set": tags, "action": "route", "outbound": policy}
            )

    def entry(item: RemoteList) -> dict[str, Any]:
        name = item.output_name
        if remote:
            return {
                "type": "remote",
                "tag": name,
                "format": "binary",
                "url": f"{REMOTE_RULE_BASE}/singbox/{name}.srs",
            }
        return {
            "type": "local",
            "tag": name,
            "format": "binary",
            "path": f"{RULESET_RELATIVE_DIR.as_posix()}/{name}.srs",
        }

    return {
        "route": {
            "rule_set": [entry(item) for item in sorted(items, key=lambda x: x.output_name)],
            "rules": rules,
        }
    }


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


def write_routeset(items: list[RemoteList]) -> None:
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
    for path, remote in ((ROUTESET_PATH, False), (REMOTE_ROUTESET_PATH, True)):
        write_text(
            path,
            json.dumps(build_routeset(items, remote=remote), ensure_ascii=False, indent=2)
            + "\n",
        )


SUFFIXES = {"singbox": ".json", "clash": ".yaml", "plain": ".list"}


def build_one(item: RemoteList) -> list[tuple[str, Path, int, int]]:
    """为单个 tag 生成全部客户端产物，返回 (client, 路径, 源行数, 跳过数)。"""
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
    return results


def cmd_extract(args: argparse.Namespace) -> int:
    all_items: list[RemoteList] = []
    for input_file in args.inputs:
        all_items.extend(extract_remote_rules(Path(input_file)))
    manifest = render_manifest(all_items)
    write_text(Path(args.output), manifest)
    print(f"manifest: {args.output} ({len(all_items)} entries)")
    return 0


def cmd_convert(args: argparse.Namespace) -> int:
    """纯转换，不联网、不写仓库目录。供测试驱动。"""
    raw = sys.stdin.read() if args.input == "-" else read_text(Path(args.input))
    emitter = CLIENT_EMITTERS[args.client]
    emission = emitter(normalize_rule_lines(raw))
    if args.output == "-":
        sys.stdout.write(emission.text)
    else:
        write_text(Path(args.output), emission.text)
    if emission.skipped and args.report:
        write_text(Path(args.report), "\n".join(emission.skipped) + "\n")
    print(f"client={args.client} skipped={len(emission.skipped)}", file=sys.stderr)
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    items = load_manifest(Path(args.manifest))
    if args.all:
        clean_generated_outputs()
        write_index(items)
        write_routeset(items)
    targets = items if args.all else [find_item(items, args.tag)]
    totals: dict[str, int] = defaultdict(int)

    for item in targets:
        results = build_one(item)
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

    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument(
        "--inputs",
        nargs="+",
        default=[str(DEFAULT_LOON_CONFIG)],
    )
    extract_parser.add_argument(
        "--output",
        default=str(DEFAULT_MANIFEST),
    )
    extract_parser.set_defaults(func=cmd_extract)

    extract_profile_parser = subparsers.add_parser("extract-profile")
    extract_profile_parser.add_argument(
        "--input",
        default=str(DEFAULT_LOON_CONFIG),
    )
    extract_profile_parser.add_argument(
        "--output",
        default=str(DEFAULT_PROFILE_PATH),
    )
    extract_profile_parser.set_defaults(func=cmd_extract_profile)

    build_parser_cmd = subparsers.add_parser("build")
    build_group = build_parser_cmd.add_mutually_exclusive_group(required=True)
    build_group.add_argument("tag", nargs="?")
    build_group.add_argument("--all", action="store_true")
    build_parser_cmd.add_argument(
        "--manifest",
        default=str(DEFAULT_MANIFEST),
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
    convert_parser.set_defaults(func=cmd_convert)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
