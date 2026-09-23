//! 路径布局。客户端只保留 YAML 配置文件路径（旧 store/local/state/output 路径已随旧交付模型裁撤）。

use std::path::PathBuf;

/// 默认客户端 YAML 配置：~/.config/sing-box/config.yaml
pub fn client_config_path() -> PathBuf {
    sb_sync_dir().join("config.yaml")
}

pub fn sb_sync_dir() -> PathBuf {
    dirs_home().join(".config").join("sing-box")
}

/// HOME 解析：缺失即 fail-fast。
fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .expect("HOME 环境变量未设置")
}
