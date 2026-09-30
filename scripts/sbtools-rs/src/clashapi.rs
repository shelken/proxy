//! Clash API 客户端：controller 发现、仅回环守卫、探活与 /version /configs /logs 读取。
//!
//! PR3 的 logs 与 PR4 的 live 归属段复用此模块，不另写第二套。
//! 惯例来源：controller 守卫与探活同 `trace.rs`，流式读取同 `server.rs` 的 ureq
//! `into_reader` 用法。

use serde_json::Value;
use std::io::{BufRead, Read};
use std::time::Duration;

/// controller 是否回环。统一解析器与 config 的拒绝判定共用，
/// 语义就是「以 127.0.0.1 开头」，与 sing-box 常见的 `127.0.0.1:9090` 写法对齐。
pub fn is_loopback(addr: &str) -> bool {
    addr.starts_with("127.0.0.1")
}

/// 配置里的 controller 原始值（不做回环守卫）。供 `resolve_controller` 判定，
/// 把「配置源没有 controller」与「有但非回环被拒」区分开，后者必须显式报错，
/// 不能静默回退到缺省口——那会连上缺省口上无关的内核。
pub fn configured_controller(cfg: &Value) -> Option<String> {
    cfg["experimental"]["clash_api"]["external_controller"]
        .as_str()
        .map(String::from)
}

/// endpoint URL 组装（controller 形如 `127.0.0.1:9090`）。
pub fn endpoint(controller: &str, path: &str) -> String {
    format!("http://{controller}{path}")
}

/// 探活：/version 2s 内可达。
pub fn reachable(controller: &str) -> bool {
    ureq::get(&endpoint(controller, "/version"))
        .timeout(Duration::from_secs(2))
        .call()
        .is_ok()
}

/// GET JSON 端点（/version、/configs 等一次性读取）。
pub fn get_json(controller: &str, path: &str) -> Result<Value, String> {
    let res = ureq::get(&endpoint(controller, path))
        .timeout(Duration::from_secs(2))
        .call()
        .map_err(|e| format!("GET {path} 失败: {e}"))?;
    let mut body = String::new();
    res.into_reader()
        .read_to_string(&mut body)
        .map_err(|e| format!("{path} 响应读取失败: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("{path} 响应不是合法 JSON: {e}"))
}

/// Controller 解析结果（强类型枚举）：杜绝把“配置了非法地址”与“未配置”混淆。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControllerResolution {
    /// 合法回环 Controller（如 127.0.0.1:9090）
    Loopback(String),
    /// 配置了非回环 Controller，显式拒绝并保留被拒地址与原因
    ExplicitReject { address: String, reason: String },
    /// 未找到任何 Controller 配置，采用缺省口 127.0.0.1:9090
    Default(String),
}

/// 统一 Controller 解析与回环安全守卫。
/// 优先级：CLI 显式指定 -> 已加载配置的 root -> overlay -> 缺省 127.0.0.1:9090。
/// 配置了非回环地址时返回 ExplicitReject，绝不静默回退（防连真机内核事故）。
pub fn resolve_controller(
    cfg: Option<&crate::config::EffectiveConfig>,
    explicit_cli: Option<&str>,
) -> ControllerResolution {
    if let Some(cli) = explicit_cli {
        if is_loopback(cli) {
            return ControllerResolution::Loopback(cli.to_string());
        }
        return ControllerResolution::ExplicitReject {
            address: cli.to_string(),
            reason: "非回环地址".to_string(),
        };
    }
    if let Some(c) = cfg {
        if let Some(raw) = configured_controller(&c.root) {
            if is_loopback(&raw) {
                return ControllerResolution::Loopback(raw);
            }
            return ControllerResolution::ExplicitReject {
                address: raw,
                reason: "非回环地址，拒绝连接".to_string(),
            };
        }
        if let Some(o) = &c.overlay {
            if let Some(raw) = configured_controller(o) {
                if is_loopback(&raw) {
                    return ControllerResolution::Loopback(raw);
                }
                return ControllerResolution::ExplicitReject {
                    address: raw,
                    reason: "非回环地址，拒绝连接".to_string(),
                };
            }
        }
    }
    ControllerResolution::Default("127.0.0.1:9090".to_string())
}

/// GET /connections 端点读取。
pub fn get_connections(controller: &str) -> Result<Value, String> {
    get_json(controller, "/connections")
}

/// GET /rules 端点读取。
pub fn get_rules(controller: &str) -> Result<Value, String> {
    get_json(controller, "/rules")
}

/// /logs 流式读取（连接建立后只吐新行，无回放）。返回逐行 `BufRead`。
///
/// 只设连接超时、不设整体超时：整体超时会在长连接上掐断跟踪流。
/// `cmd_logs -f` 是当前调用方，PR4 的 live 归属段复用。
pub fn logs_stream(controller: &str, level: &str) -> Result<impl BufRead, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .build();
    let res = agent
        .get(&endpoint(controller, &format!("/logs?level={level}")))
        .call()
        .map_err(|e| format!("GET /logs 失败: {e}"))?;
    Ok(std::io::BufReader::new(res.into_reader()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn endpoint_assembles_base_url() {
        assert_eq!(
            endpoint("127.0.0.1:9090", "/configs"),
            "http://127.0.0.1:9090/configs"
        );
    }

    /// 一次性 TCP 服务：先排空客户端请求（真实 HTTP 服务端行为——不读就 close
    /// 会带未读数据触发 RST，macOS 上表现为 EINVAL 而非 EOF），再按 chunked
    /// 编码推两行 JSON 后关闭。验证流式 reader 经 ureq 反 chunk 后能逐行读出。
    #[test]
    fn logs_stream_reads_line_by_line() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let (sock, _) = listener.accept().unwrap();
            let mut req = std::io::BufReader::new(&sock);
            let mut request_line = String::new();
            req.read_line(&mut request_line).unwrap();
            loop {
                let mut line = String::new();
                if req.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            drop(req);
            let mut sock = sock;
            sock.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                  Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
            for line in [
                r#"{"payload":"line-a","type":"log"}"#,
                r#"{"payload":"line-b","type":"log"}"#,
            ] {
                let body = format!("{line}\n");
                sock.write_all(format!("{:x}\r\n{body}\r\n", body.len()).as_bytes())
                    .unwrap();
            }
            sock.write_all(b"0\r\n\r\n").unwrap();
            request_line
        });

        let mut reader = logs_stream(&addr.to_string(), "debug").expect("应连上测试服务");
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        let mut second = String::new();
        reader.read_line(&mut second).unwrap();
        assert_eq!(first.trim_end(), r#"{"payload":"line-a","type":"log"}"#);
        assert_eq!(second.trim_end(), r#"{"payload":"line-b","type":"log"}"#);
        // 终止块之后到达 EOF
        let mut third = String::new();
        assert_eq!(reader.read_line(&mut third).unwrap(), 0);
        // 级别透传进 /logs 查询串
        assert_eq!(handle.join().unwrap(), "GET /logs?level=debug HTTP/1.1\r\n");
    }

    #[test]
    fn get_json_reports_endpoint_in_errors() {
        // 未监听端口: 报错必须含端点路径, 不悬挂
        let err = get_json("127.0.0.1:1", "/configs").unwrap_err();
        assert!(err.contains("/configs"), "实际: {err}");
    }
}
