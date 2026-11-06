//! 内核 CLI：定位 `sing-box` 可执行文件，调用其 `merge` 与 `check` 子命令。
//!
//! 定位顺序与 justfile 的 `SING_BOX` 约定一致。merge 的输入层按文件名字典序
//! 确定优先级，`LAYER_*` 是本模块与调用方共用的承重契约。

use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static REQUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// 定位内核可执行文件：优先 `SING_BOX`，否则 PATH 上的 `sing-box`。
///
/// 抽成独立函数而非内联在调用点：沙箱里内核装在 /opt/proxy-test/bin 不在 PATH 上，
/// 与 justfile 的 `SING_BOX` 约定一致。
pub fn resolve_singbox_binary() -> std::ffi::OsString {
    resolve_singbox_from(std::env::var_os("SING_BOX"))
}

/// 定位规则本体，与进程环境解耦以便确定性测试。
///
/// 空值视作未设置：`SING_BOX=` 若被当成路径会得到「启动内核失败（空路径）」，
/// 比回落到 PATH 更难排查。这与 justfile `env_var_or_default` 的语义一致。
fn resolve_singbox_from(env_value: Option<std::ffi::OsString>) -> std::ffi::OsString {
    match env_value {
        Some(v) if !v.is_empty() => v,
        _ => std::ffi::OsString::from("sing-box"),
    }
}

/// 请求独立临时目录（进程唯一 + 请求序号），RAII 清理。
struct TempMergeDir {
    path: PathBuf,
}

impl TempMergeDir {
    fn create() -> Result<Self, String> {
        let seq = REQUEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("sbtools-merge-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&path).map_err(|e| format!("创建临时目录失败: {e}"))?;
        Ok(Self { path })
    }
}

impl Drop for TempMergeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// merge 输入层的文件名。**字典序 = 合并优先级**，前缀不是序号而是语义：
/// 数组按此序拼接（先者在前），标量取先者（first wins）。改名会让覆盖关系静默翻转。
///
/// - `00-direct` 反回环直连规则，必须排在所有规则之前（含设备 overlay 的规则）
/// - `01-overlay` 设备侧覆盖，需压过底模标量
/// - `02-base` 底模本体
pub const LAYER_DIRECT: &str = "00-direct";
pub const LAYER_OVERLAY: &str = "01-overlay";
pub const LAYER_BASE: &str = "02-base";

/// 合并各输入层，返回结果 JSON 字符串。
///
/// `layers` 是 `(文件名前缀, 内容)` 列表，**其名字的字典序决定合并顺序**：
/// 数组按文件名字典序拼接、标量取字典序最前的那份（实测，与 `-c` 的 argv 顺序
/// 无关）。调用方必须按期望优先级给出层名。
pub fn merge_layers(layers: &[(&str, &Value)]) -> Result<String, String> {
    let dir = TempMergeDir::create()?;
    run_singbox_merge_with(&resolve_singbox_binary(), &dir, layers)
}

/// merge 实现本体，内核路径由参数注入：测试需要验证「路径不存在时报错指向该路径」
/// 这条契约，而内联读环境变量无法确定性覆盖（env 是进程全局，并行测试下互相污染）。
fn run_singbox_merge_with(
    bin: &std::ffi::OsStr,
    dir: &TempMergeDir,
    layers: &[(&str, &Value)],
) -> Result<String, String> {
    // 层按文件名字典序生效，调用方必须已按期望顺序给出；这里只按序落盘。
    let mut args: Vec<String> = Vec::with_capacity(layers.len() * 2);
    for (name, value) in layers {
        let path = dir.path.join(format!("{name}.json"));
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(value).map_err(|e| format!("序列化 {name} 失败: {e}"))?,
        )
        .map_err(|e| format!("写 {name} 失败: {e}"))?;
        args.push("-c".into());
        args.push(path.display().to_string());
    }

    let result_path = dir.path.join("result.json");
    let output = std::process::Command::new(bin)
        .arg("merge")
        .arg(result_path.display().to_string())
        .args(&args)
        .output()
        .map_err(|e| format!("启动内核失败（{}）: {e}", bin.to_string_lossy()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let brief: String = stderr.lines().take(5).collect::<Vec<_>>().join("; ");
        return Err(format!("内核 merge 失败: {brief}"));
    }
    std::fs::read_to_string(&result_path).map_err(|e| format!("读取合并结果失败: {e}"))
}

/// 离线校验用：把 overlay 合并到底模上，返回合并结果 JSON。
///
/// 与 `handle_sub` 走同一条合并路径（同一套层名与优先级），差别只在没有反回环层
/// （它需要订阅节点，属运行期数据）。层序不变，故 overlay 与底模的相对优先级一致。
pub fn merge_overlay(base: &Value, overlay: Option<&Value>) -> Result<Value, String> {
    let mut layers: Vec<(&str, &Value)> = Vec::with_capacity(2);
    if let Some(ov) = overlay {
        layers.push((LAYER_OVERLAY, ov));
    }
    layers.push((LAYER_BASE, base));
    let text = merge_layers(&layers)?;
    serde_json::from_str(&text).map_err(|e| format!("合并结果不是合法 JSON: {e}"))
}

/// 离线校验用：对配置跑一次内核 `check`（只验语法与引用，不建 TUN、不联网）。
pub fn kernel_check(cfg: &Value) -> Result<(), String> {
    let dir = TempMergeDir::create()?;
    let path = dir.path.join("candidate.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(cfg).map_err(|e| format!("序列化候选配置失败: {e}"))?,
    )
    .map_err(|e| format!("写候选配置失败: {e}"))?;
    let output = std::process::Command::new(resolve_singbox_binary())
        .arg("check")
        .arg("-c")
        .arg(path.display().to_string())
        .output()
        .map_err(|e| format!("启动内核失败: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let brief: String = stderr
        .lines()
        .filter(|l| !l.trim().is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("\n  ");
    Err(format!("内核 check 失败:\n  {brief}"))
}

/// e2e 测试的内核门禁：返回 `Some(原因)` 表示应跳过，`None` 表示可用。
///
/// 显式设置了 `SING_BOX` 却不可用时**不跳过**：沙箱里内核装在
/// `/opt/proxy-test/bin` 不在 PATH，全靠这个变量定位，静默跳过会让 e2e
/// 覆盖率降级且无人察觉——那正是这些测试存在的意义。只有「未显式设置
/// 且 PATH 上也没有」才允许跳过（开发机上没装内核的常见情形）。
#[cfg(test)]
pub(crate) fn kernel_unavailable_reason() -> Option<String> {
    let bin = resolve_singbox_binary();
    let explicit = std::env::var_os("SING_BOX").is_some_and(|v| !v.is_empty());
    let probe = std::process::Command::new(&bin).arg("version").output();

    let detail = match probe {
        Ok(o) if o.status.success() => return None,
        Ok(o) => format!("退出码 {:?}", o.status.code()),
        Err(e) => format!("无法执行: {e}"),
    };

    assert!(
        !explicit,
        "SING_BOX 已显式设为 {bin:?} 但不可用（{detail}）：\
         这是环境配置错误，不能按「内核缺失」跳过",
    );
    Some(format!("{bin:?} 不可用（{detail}）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 定位规则：SING_BOX 有值即采用，未设置或空值回落到 PATH 上的 sing-box。
    /// 空值必须回落 —— `SING_BOX=` 被当成路径会产生「启动内核失败（空路径）」，
    /// 比回落到 PATH 更难排查。
    #[test]
    fn singbox_binary_prefers_env_then_falls_back() {
        assert_eq!(
            resolve_singbox_from(Some("/opt/proxy-test/bin/sing-box".into())),
            std::ffi::OsString::from("/opt/proxy-test/bin/sing-box")
        );
        assert_eq!(
            resolve_singbox_from(None),
            std::ffi::OsString::from("sing-box")
        );
        assert_eq!(
            resolve_singbox_from(Some(std::ffi::OsString::new())),
            std::ffi::OsString::from("sing-box"),
            "空值须回落，而非当作空路径"
        );
    }

    /// SING_BOX 指向的路径必须真的被用作可执行文件。
    /// 用一个打印参数的假二进制验证：若实现只读环境变量而仍调用 PATH 上的 sing-box，
    /// 这条断言会因拿到真实 sing-box 的输出而失败。
    #[test]
    #[cfg(unix)]
    fn singbox_env_path_is_actually_executed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("sbtools-fakebox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("fake-sing-box");
        std::fs::write(&fake, "#!/bin/sh\necho FAKE_KERNEL_MARKER \"$@\"\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();

        // 其他测试线程 fork 时会让刚写完的脚本短暂处于「文本文件忙」（ETXTBSY），Linux 上直接执行会失败，重试即可
        let out = (0..20)
            .find_map(|_| {
                match std::process::Command::new(resolve_singbox_from(Some(fake.clone().into())))
                    .arg("version")
                    .output()
                {
                    Err(e) if e.raw_os_error() == Some(26) => {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        None
                    }
                    other => Some(other),
                }
            })
            .expect("重试后仍是文本文件忙")
            .expect("假内核应可执行");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("FAKE_KERNEL_MARKER"),
            "应执行 SING_BOX 指定的程序，实际输出: {stdout}"
        );
        assert!(
            stdout.contains("version"),
            "参数应透传给该程序，实际输出: {stdout}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 内核路径不存在时，报错必须含该路径本身。
    /// 报错只说「启动失败」会让沙箱里调试的人先去怀疑 PATH，
    /// 而真正的问题在 SING_BOX 指向了一个不存在的文件。
    #[test]
    fn missing_kernel_error_names_the_path() {
        let dir = TempMergeDir::create().unwrap();
        let base = serde_json::json!({"outbounds": []});
        let layers = [(LAYER_BASE, &base)];
        let bad = std::ffi::OsString::from("/nonexistent/definitely-not-a-kernel");
        let err = run_singbox_merge_with(&bad, &dir, &layers).unwrap_err();
        assert!(
            err.contains("/nonexistent/definitely-not-a-kernel"),
            "报错须含注入的内核路径，实际: {err}"
        );
    }

    /// 内核 merge 失败时，报错须带上其 stderr 摘要（截前 5 行）。
    /// 否则用户只看到「失败」而不知道是 overlay 语法错还是底模冲突。
    #[test]
    #[cfg(unix)]
    fn kernel_failure_surfaces_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempMergeDir::create().unwrap();
        let script_dir =
            std::env::temp_dir().join(format!("sbtools-badbox-{}", std::process::id()));
        std::fs::create_dir_all(&script_dir).unwrap();
        let bad = script_dir.join("bad-kernel");
        std::fs::write(
            &bad,
            "#!/bin/sh\necho 'ERROR: overlay 非法字段 xxx' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o755)).unwrap();

        let base = serde_json::json!({"outbounds": []});
        let layers = [(LAYER_BASE, &base)];
        // 其他测试线程 fork 时会让刚写完的脚本短暂处于「文本文件忙」，Linux 上直接执行会失败，重试即可
        let err = (0..20)
            .map(|_| run_singbox_merge_with(bad.as_os_str(), &dir, &layers).unwrap_err())
            .find(|e| {
                let busy = e.contains("Text file busy");
                if busy {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                !busy
            })
            .expect("重试后仍是文本文件忙");
        assert!(
            err.contains("overlay 非法字段"),
            "应带上 stderr 摘要，实际: {err}"
        );
        let _ = std::fs::remove_dir_all(&script_dir);
    }

    /// 守 merge 的标量优先级契约：层名字典序在前的层，标量胜出。
    ///
    /// 这条依赖内核的实测行为（`kernel.rs` 里 LAYER_* 的注释所述），一旦内核
    /// 改变语义，overlay 覆盖底模标量会静默失效。没有断言时只能靠线上现象发现。
    #[test]
    fn overlay_scalar_wins_over_base_after_merge() {
        if let Some(reason) = kernel_unavailable_reason() {
            eprintln!("skip: {reason}");
            return;
        }
        let base = serde_json::json!({
            "log": {"level": "warn"},
            "route": {"final": "proxy", "default_domain_resolver": {"server": "dns-direct-cn"}}
        });
        let overlay = serde_json::json!({
            "log": {"level": "debug"},
            "route": {"default_domain_resolver": {"server": "dns-lan"}}
        });
        let merged = merge_overlay(&base, Some(&overlay)).expect("合并应成功");
        assert_eq!(
            merged["log"]["level"],
            serde_json::json!("debug"),
            "overlay 标量应压过底模"
        );
        // 内核 merge 会把 `{server: x}` 规范成裸字符串（实测），直接钉住生效值。
        // 不写「对象或字符串都接受」的兜底：那等于把这条测试要守的优先级放宽成
        // 两种形态之一，覆盖失效时也能通过。
        assert_eq!(
            merged["route"]["default_domain_resolver"],
            serde_json::json!("dns-lan"),
            "overlay 的 resolver 应胜出并规范成裸字符串"
        );

        // 无 overlay 时底模标量保留，且同样被规范化——这是上面断言的对照面：
        // 若合并方向反了，这里会拿到 dns-direct-cn 而不是 dns-lan
        let merged_base = merge_overlay(&base, None).expect("无 overlay 合并应成功");
        assert_eq!(merged_base["log"]["level"], serde_json::json!("warn"));
        assert_eq!(
            merged_base["route"]["default_domain_resolver"],
            serde_json::json!("dns-direct-cn"),
            "无 overlay 时应保留底模的 resolver"
        );
    }

    /// 守 merge 的「同名 tag 不可覆盖」契约，并钉住 1.14.3 起的新语义。
    ///
    /// 结构合并本身不看 tag 语义：同名 `dns.servers` 在合并产物里**两条并存**，
    /// 不会互相覆盖。1.14.2 及以前运行期是「后来者替换先到者」，表现为 `02-base`
    /// 静默胜出；1.14.3 起建 DNS 传输时直接报 `duplicate DNS server tag`。
    ///
    /// 方向与 `overlay_scalar_wins_over_base_after_merge` 相反，这正是「一个字典序
    /// 无法同时满足标量覆盖与按 tag 覆盖」的证据：若用 overlay 按 tag 换底模的 DNS
    /// server，本 pin 版本下产出的配置**起不来**，devices 拿到的是一个坏订阅。
    #[test]
    fn duplicate_dns_server_tag_is_rejected_not_overridden() {
        if let Some(reason) = kernel_unavailable_reason() {
            eprintln!("skip: {reason}");
            return;
        }
        let base = serde_json::json!({
            "dns": {
                "servers": [{"type": "udp", "tag": "shared", "server": "192.0.2.53"}],
                "final": "shared"
            }
        });
        let overlay = serde_json::json!({
            "dns": {"servers": [{"type": "udp", "tag": "shared", "server": "198.51.100.53"}]}
        });

        let merged = merge_overlay(&base, Some(&overlay)).expect("结构合并应成功");
        let servers = merged["dns"]["servers"].as_array().expect("servers 为数组");
        assert_eq!(servers.len(), 2, "同名 tag 在合并产物中并存，而非互相覆盖");
        assert_eq!(servers[0]["tag"], serde_json::json!("shared"));
        assert_eq!(servers[1]["tag"], serde_json::json!("shared"));

        let err = kernel_check(&merged).expect_err("同名 tag 的产物不得通过 check");
        assert!(
            err.contains("duplicate DNS server tag"),
            "内核应拒绝同名 DNS server tag，实际: {err}"
        );
    }
}
