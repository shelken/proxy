//! 路径布局。客户端只保留 YAML 配置文件路径（旧 store/local/state/output 路径已随旧交付模型裁撤）。

use std::path::PathBuf;

/// 默认客户端 YAML 配置：~/.config/sing-box/config.yaml
pub fn client_config_path() -> Result<PathBuf, String> {
    Ok(sb_sync_dir()?.join("config.yaml"))
}

/// HOME 缺失即报错：路径无处可推，继续执行只会读出错误的文件。
fn sb_sync_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "HOME 环境变量未设置".to_string())?;
    Ok(home.join(".config").join("sing-box"))
}
