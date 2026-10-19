//! iOS 底模走真实装配（节点注入、策略组展开、保留标签）后必须仍被内核接受（ADR-0010）。
//! 底模含 `endpoints` 与指向 endpoint 的路由目标，装配器只认 outbounds，这里锁住两者不互相打架。

use sbtools::assemble::finalize;
use sbtools::config::reject_path_fields;
use sbtools::template::resolve_singbox_binary;
use serde_json::{Value, json};

fn kernel_available() -> bool {
    let explicit = std::env::var_os("SING_BOX").is_some_and(|v| !v.is_empty());
    let ok = std::process::Command::new(resolve_singbox_binary())
        .arg("version")
        .output()
        .is_ok_and(|o| o.status.success());
    // 显式指定内核却不可用是环境错误，不能静默跳过
    assert!(ok || !explicit, "SING_BOX 已设置但内核不可用");
    ok
}

fn ss(tag: &str, server: &str) -> Value {
    json!({
        "type": "shadowsocks", "tag": tag, "server": server, "server_port": 8388,
        "method": "aes-128-gcm", "password": "pw"
    })
}

#[test]
fn ios_template_assembles_and_passes_kernel_check() {
    if !kernel_available() {
        eprintln!("跳过：内核不可用");
        return;
    }
    let mut tpl: Value =
        serde_json::from_str(include_str!("../../../config/sing-box/template-ios.json"))
            .expect("iOS 底模应为合法 JSON");
    // 客户端走 template_url 下载底模时同样要过这一关，state_directory 不在禁用字段内
    reject_path_fields(&tpl).expect("iOS 底模应通过远程底模的路径字段校验");
    let nodes = vec![ss("HK-01", "192.0.2.10"), ss("JP-01", "192.0.2.11")];
    finalize(&mut tpl, nodes).expect("装配应成功");
    assert_eq!(
        tpl["endpoints"][0]["tag"], "ts-ep",
        "装配不应丢失 endpoints"
    );

    let dir = std::env::temp_dir().join(format!("sbtools-ios-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("临时目录");
    let path = dir.join("assembled.json");
    std::fs::write(&path, serde_json::to_vec(&tpl).expect("序列化")).expect("写候选配置");
    let out = std::process::Command::new(resolve_singbox_binary())
        .args(["check", "-D"])
        .arg(&dir)
        .arg("-c")
        .arg(&path)
        .output()
        .expect("启动内核");
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        out.status.success(),
        "装配后的 iOS 配置应通过内核 check，实际: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
