//! Clash API 客户端：controller 发现、仅回环守卫、探活与 /version /configs /logs 读取。
//!
//! PR3 的 logs 与 PR4 的 live 归属段复用此模块，不另写第二套。
//! 惯例来源：controller 守卫与探活同 `trace.rs`，流式读取同 `server.rs` 的 ureq
//! `into_reader` 用法。

use serde_json::Value;
use std::io::{BufRead, Read};
use std::time::Duration;

/// 从生效配置读取 `experimental.clash_api.external_controller`。
///
/// 仅放行 127.0.0.1 回环：后续要把本机观测数据拉回来，不该发往非回环地址。
pub fn discover_controller(cfg: &Value) -> Option<String> {
    let ec = cfg["experimental"]["clash_api"]["external_controller"].as_str()?;
    if ec.starts_with("127.0.0.1") {
        Some(ec.to_string())
    } else {
        None
    }
}

/// 配置里的 controller 原始值（不做回环守卫）。与 `discover_controller` 配合，
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
    use serde_json::json;
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn controller_discovery_requires_loopback() {
        let cfg = json!({"experimental": {"clash_api": {"external_controller": "127.0.0.1:9090"}}});
        assert_eq!(discover_controller(&cfg).as_deref(), Some("127.0.0.1:9090"));
        // 非回环地址必须拒绝
        let cfg = json!({"experimental": {"clash_api": {"external_controller": "0.0.0.0:9090"}}});
        assert_eq!(discover_controller(&cfg), None);
        let cfg = json!({"experimental": {"clash_api": {"external_controller": "192.0.2.5:9090"}}});
        assert_eq!(discover_controller(&cfg), None);
        // 客户端 YAML 无 clash_api 键
        assert_eq!(discover_controller(&json!({})), None);
    }

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
