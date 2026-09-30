//! 路径布局。客户端只保留 YAML 配置文件路径（旧 store/local/state/output 路径已随旧交付模型裁撤）。

use std::path::{Path, PathBuf};

/// 默认客户端 YAML 配置：~/.config/sing-box/config.yaml
pub fn client_config_path() -> Result<PathBuf, String> {
    Ok(sing_box_dir()?.join("config.yaml"))
}

/// 生效配置发现结果：磁盘文件路径与是否来自 `--path` 显式指定。
#[derive(Debug)]
pub struct EffectiveConfig {
    pub path: PathBuf,
    pub explicit: bool,
}

/// 生效配置发现链：`--path` 覆盖 → `~/.config/sing-box/config.yaml` → legacy
/// `singbox.json`（SFM 新架构无本地产物，legacy 仅为兼容旧路径）。
/// 都找不到时报错并列出已查找路径，不静默假定。
pub fn discover_effective(explicit: Option<&Path>) -> Result<EffectiveConfig, String> {
    if let Some(p) = explicit {
        return Ok(EffectiveConfig {
            path: p.to_path_buf(),
            explicit: true,
        });
    }
    discover_in(&sing_box_dir()?)
}

fn discover_in(dir: &Path) -> Result<EffectiveConfig, String> {
    let yaml = dir.join("config.yaml");
    if yaml.is_file() {
        return Ok(EffectiveConfig {
            path: yaml,
            explicit: false,
        });
    }
    let legacy = dir.join("singbox.json");
    if legacy.is_file() {
        return Ok(EffectiveConfig {
            path: legacy,
            explicit: false,
        });
    }
    Err(format!(
        "未找到生效配置（已查找 {} 与 {}）",
        yaml.display(),
        legacy.display()
    ))
}

/// HOME 缺失即报错：路径无处可推，继续执行只会读出错误的文件。
fn sing_box_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "HOME 环境变量未设置".to_string())?;
    Ok(home.join(".config").join("sing-box"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 独立临时 HOME，不碰 env，避免并行测试串扰。
    fn temp_home(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sbtools-paths-{tag}-{}", std::process::id()))
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn discovery_chain_prefers_yaml_then_legacy() {
        let dir = temp_home("chain").join(".config/sing-box");
        let _ = std::fs::remove_dir_all(&dir);
        // 都不存在 → 报错且列出两个候选路径
        let err = discover_in(&dir).unwrap_err();
        assert!(
            err.contains("config.yaml") && err.contains("singbox.json"),
            "实际: {err}"
        );
        // legacy 先顶上
        write(&dir.join("singbox.json"), "{}");
        assert_eq!(discover_in(&dir).unwrap().path, dir.join("singbox.json"));
        // config.yaml 优先于 legacy
        write(&dir.join("config.yaml"), "subs: []");
        assert_eq!(discover_in(&dir).unwrap().path, dir.join("config.yaml"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn explicit_path_overrides_discovery() {
        let dir = temp_home("explicit").join(".config/sing-box");
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir.join("config.yaml"), "subs: []");
        let legacy = dir.join("singbox.json");
        // 显式 --path 无视发现链，文件不存在也不在发现层拦截（读文件时自然报错）
        let eff = discover_effective(Some(&legacy)).unwrap();
        assert!(eff.explicit);
        assert_eq!(eff.path, legacy);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
