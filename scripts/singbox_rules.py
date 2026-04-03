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
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
REMOTE_RULE_BASE = "https://raw.githubusercontent.com/shelken/proxy/sing-box-rules"
DEFAULT_LOON_CONFIG = ROOT / "config/loon/mac.conf"
DEFAULT_MANIFEST = ROOT / "config/sing-box/rules/lists/remote.txt"
DEFAULT_PROFILE_PATH = ROOT / "config/sing-box/meta/generated/loon-profile.json"
SOURCE_DIR = ROOT / "config/sing-box/rules/source/generated"
SRS_DIR = ROOT / "config/sing-box/rules/srs/generated"
UNSUPPORTED_DIR = SOURCE_DIR / "unsupported"
INDEX_PATH = ROOT / "config/sing-box/rules/generated-index.json"
SING_GEOIP_PREFIX = "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set"
SING_GEOSITE_PREFIX = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set"

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
    "PORT": "port",
    "PROCESS-NAME": "process_name",
}

UNSUPPORTED_TYPES = {
    "USER-AGENT",
    "URL-REGEX",
    "IP-ASN",
    "DEST-PORT",
    "IN-PORT",
    "NETWORK",
    "PROTOCOL",
}


@dataclass(frozen=True)
class RemoteList:
    tag: str
    policy: str
    url: str
    source: str

    @property
    def output_name(self) -> str:
        filename = Path(urllib.parse.urlparse(self.url).path).name
        stem = Path(filename).stem or filename or self.tag
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("_")
        return safe or "rule"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def clean_generated_outputs() -> None:
    for directory in (SOURCE_DIR, SRS_DIR, UNSUPPORTED_DIR):
        directory.mkdir(parents=True, exist_ok=True)
        for path in directory.iterdir():
            if path.name == ".gitkeep":
                continue
            if path.is_file():
                path.unlink()
    if INDEX_PATH.exists():
        INDEX_PATH.unlink()


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
        items.append(RemoteList(tag=tag, policy=policy, url=url, source="loon"))
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
        items.append(RemoteList(tag=provider, policy=policy, url=url, source="clash"))
    return items


def extract_remote_rules(path: Path) -> list[RemoteList]:
    text = read_text(path)
    if "[Remote Rule]" in text:
        return parse_loon_remote_rules(text)
    if "rule-providers:" in text and "rules:" in text:
        return parse_clash_remote_rules(text)
    raise ValueError(f"unsupported config format: {path}")


def render_manifest(items: list[RemoteList]) -> str:
    lines = ["# tag|policy|url|source"]
    unique = {(item.tag, item.policy, item.url, item.source): item for item in items}
    for item in sorted(unique.values(), key=lambda x: (x.tag.lower(), x.url)):
        lines.append(f"{item.tag}|{item.policy}|{item.url}|{item.source}")
    lines.append("")
    return "\n".join(lines)


def load_manifest(path: Path) -> list[RemoteList]:
    items: list[RemoteList] = []
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split("|")
        if len(parts) not in (3, 4):
            raise ValueError(f"invalid manifest line: {line}")
        tag, policy, url = [part.strip() for part in parts[:3]]
        source = parts[3].strip() if len(parts) == 4 else "unknown"
        items.append(RemoteList(tag=tag, policy=policy, url=url, source=source))
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


def build_index(items: list[RemoteList]) -> dict[str, Any]:
    entries = []
    for item in items:
        entries.append(
            {
                "tag": item.tag,
                "policy": item.policy,
                "url": item.url,
                "source": item.source,
                "output_name": item.output_name,
                "source_path": f"config/sing-box/rules/source/generated/{item.output_name}.json",
                "srs_path": f"config/sing-box/rules/srs/generated/{item.output_name}.srs",
                "unsupported_path": f"config/sing-box/rules/source/generated/unsupported/{item.output_name}.txt",
                "remote_source_url": f"{REMOTE_RULE_BASE}/source/{item.output_name}.json",
                "remote_srs_url": f"{REMOTE_RULE_BASE}/srs/{item.output_name}.srs",
                "remote_unsupported_url": f"{REMOTE_RULE_BASE}/unsupported/{item.output_name}.txt",
            }
        )
    return {"version": 1, "entries": entries}


def write_index(items: list[RemoteList]) -> None:
    write_text(
        INDEX_PATH, json.dumps(build_index(items), ensure_ascii=False, indent=2) + "\n"
    )


def build_one(item: RemoteList) -> tuple[Path, Path, Path | None, int, int]:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    SRS_DIR.mkdir(parents=True, exist_ok=True)
    UNSUPPORTED_DIR.mkdir(parents=True, exist_ok=True)

    content = fetch_text(item.url)
    rule_lines = normalize_rule_lines(content)
    rules, special_refs, unsupported = convert_rule_lines(rule_lines)

    source_path = SOURCE_DIR / f"{item.output_name}.json"
    srs_path = SRS_DIR / f"{item.output_name}.srs"
    unsupported_path = UNSUPPORTED_DIR / f"{item.output_name}.txt"

    if special_refs and not rules and not unsupported:
        source_json = special_ref_to_metadata(special_refs)
        write_text(
            source_path, json.dumps(source_json, ensure_ascii=False, indent=2) + "\n"
        )
        download_special_srs(special_refs, srs_path)
    else:
        source_json = to_source_json(rules)
        write_text(
            source_path, json.dumps(source_json, ensure_ascii=False, indent=2) + "\n"
        )
        compile_srs(source_path, srs_path)

    if unsupported:
        write_text(unsupported_path, "\n".join(unsupported) + "\n")
    elif unsupported_path.exists():
        unsupported_path.unlink()
    return (
        source_path,
        srs_path,
        unsupported_path if unsupported else None,
        len(rule_lines),
        len(unsupported),
    )


def find_item(items: list[RemoteList], target: str) -> RemoteList:
    normalized = target.lower()
    for item in items:
        if item.tag.lower() == normalized or item.output_name.lower() == normalized:
            return item
    raise KeyError(f"tag not found: {target}")


def cmd_extract(args: argparse.Namespace) -> int:
    all_items: list[RemoteList] = []
    for input_file in args.inputs:
        all_items.extend(extract_remote_rules(Path(input_file)))
    manifest = render_manifest(all_items)
    write_text(Path(args.output), manifest)
    write_index(load_manifest(Path(args.output)))
    print(f"manifest: {args.output} ({len(all_items)} entries)")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    items = load_manifest(Path(args.manifest))
    if args.all:
        clean_generated_outputs()
        write_index(items)
    targets = items if args.all else [find_item(items, args.tag)]
    built = 0
    dropped = 0
    for item in targets:
        source_path, srs_path, unsupported_path, total, unsupported = build_one(item)
        built += 1
        dropped += unsupported
        summary = (
            f"built {item.tag} -> {source_path.relative_to(ROOT)}, "
            f"{srs_path.relative_to(ROOT)}, total={total}, unsupported={unsupported}"
        )
        if unsupported_path:
            summary += f", report={unsupported_path.relative_to(ROOT)}"
        print(summary)
    print(f"done: built={built}, unsupported={dropped}")
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

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
