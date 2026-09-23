//! sb-sync — 客户端加密编码 + 服务端原生合并，双形态单二进制。
//!
//! 客户端: encode（YAML → 加密 URL → 剪切板）；辅助: keygen。
//! 服务端: server（解密 → 装配 → 官方 sing-box merge → 响应）。

mod assemble;
mod config;
mod crypto;
mod node;
mod paths;
mod server;
mod template;

use std::process::Command;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str);
    let rest: &[String] = args.get(1..).unwrap_or(&[]);

    let result = match cmd {
        Some("encode") => cmd_encode(rest),
        Some("server") => cmd_server(rest),
        Some("keygen") => {
            let (sk, pk) = config::keygen();
            println!("SERVER_PRIVATE_KEY={sk}");
            println!("SERVER_PUBLIC_KEY={pk}");
            Ok(())
        }
        Some("version") | Some("--version") | Some("-V") => {
            println!("sb-sync {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => {
            eprintln!("{}", usage());
            std::process::exit(if cmd.is_none() { 0 } else { 1 });
        }
    };
    if let Err(e) = result {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    }
}

fn usage() -> String {
    [
        "sb-sync — 客户端加密编码 + 服务端原生合并",
        "",
        "用法:",
        "  sb-sync encode [-c <config.yaml>]   校验 YAML、加密生成订阅 URL 并写入剪切板",
        "  sb-sync server [--port 8080]        启动服务端（需 SERVER_PRIVATE_KEY 环境变量）",
        "  sb-sync keygen                      生成服务端 X25519 公私钥对（Hex）",
        "  sb-sync version                     显示版本",
    ]
    .join("\n")
}

/// encode: 读取 YAML → 校验 → 加密 → URL → pbcopy。
fn cmd_encode(rest: &[String]) -> Result<(), String> {
    let config_path = match rest {
        [flag, path] if flag == "-c" || flag == "--config" => std::path::PathBuf::from(path),
        [] => paths::client_config_path(),
        _ => return Err("encode 用法: sb-sync encode [-c <config.yaml>]".into()),
    };
    let config = config::load_config(&config_path)?;
    let ciphertext = config::encode_payload(&config)?;
    let url = config::build_url(&config, &ciphertext)?;

    // 写剪切板（macOS pbcopy；非 macOS 环境失败不阻断，仅提示）
    match Command::new("pbcopy").stdin(std::process::Stdio::piped()).spawn() {
        Ok(mut child) => {
            use std::io::Write;
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(url.as_bytes());
            }
            let _ = child.wait();
            println!("✓ 订阅 URL 已复制到剪切板");
        }
        Err(_) => println!("（未找到 pbcopy，请手动复制下方 URL）"),
    }
    println!("{url}");
    Ok(())
}

/// server: 解析端口并启动服务循环。
fn cmd_server(rest: &[String]) -> Result<(), String> {
    let port: u16 = match rest {
        [p] if p == "--port" || p == "-p" => return Err("server: --port 需要一个数字参数".into()),
        [flag, p] if flag == "--port" || flag == "-p" => {
            p.parse().map_err(|_| format!("非法端口: {p}"))?
        }
        [] => std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080),
        _ => return Err("server 用法: sb-sync server [--port 8080]".into()),
    };
    server::run(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_lists_only_new_commands() {
        let u = usage();
        assert!(u.contains("encode"));
        assert!(u.contains("server"));
        assert!(u.contains("keygen"));
        assert!(!u.contains("doctor"));
        assert!(!u.contains("sb-sync sync"));
    }
}
