#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

suite, run_root, commit = sys.argv[1:]
root = Path(run_root)
for key in list(os.environ):
    if key.lower().endswith("_proxy"):
        os.environ.pop(key)
os.environ.update(SBTOOLS_BIN=str(root / "sbtools"), SOURCE_ROOT=str(root / "source"), SING_BOX="/opt/proxy-test/bin/sing-box", EXPECTED_COMMIT=commit)
if suite != "remote":
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    subprocess.run(["ip", "addr", "add", "203.0.113.10/32", "dev", "lo"], check=True)
    resolv = Path.cwd() / "resolv.conf"
    resolv.write_text("nameserver 127.0.0.1\noptions timeout:1 attempts:1\n")
    hosts = Path.cwd() / "hosts"
    hosts.write_text("127.0.0.1 localhost\n::1 localhost\n")
    subprocess.run(["mount", "--bind", str(resolv), "/etc/resolv.conf"], check=True)
    subprocess.run(["mount", "--bind", str(hosts), "/etc/hosts"], check=True)
    links = json.loads(subprocess.check_output(["ip", "-j", "link"]))
    routes = subprocess.check_output(["ip", "route", "show", "default"]).decode()
    if [link["ifname"] for link in links] != ["lo"] or routes:
        raise RuntimeError("network namespace has an external interface or route")
    (Path.cwd() / "isolation.json").write_text(json.dumps({"interfaces": ["lo"], "default_routes": routes, "network_namespace": os.readlink("/proc/self/ns/net")}, indent=2))
else:
    resolv = Path.cwd() / "resolv.conf"
    resolv.write_text("nameserver 127.0.0.10\noptions timeout:2 attempts:1\n")
    subprocess.run(["mount", "--bind", str(resolv), "/etc/resolv.conf"], check=True)
bun = "/opt/proxy-test/bin/bun"
os.execve(bun, [bun, "--no-env-file", "test", str(root / "kit" / (suite + ".test.js")), "--timeout", "30000"], os.environ)
