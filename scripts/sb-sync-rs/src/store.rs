//! store.json / state.json 数据结构与读写。

use crate::paths;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default)]
pub struct Store {
    #[serde(default)]
    pub subs: Vec<String>,
    #[serde(default)]
    pub nodes: Vec<String>,
    /// 每次 sync 是否自动检查远程底模更新（默认 true）。
    #[serde(default = "default_true")]
    pub template_auto_update: bool,
    /// 产物输出路径覆盖；默认 ~/.config/sing-box/singbox.json
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Default)]
pub struct State {
    #[serde(default = "default_template_source")]
    pub template_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_fetched_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

fn default_template_source() -> String {
    "embedded".into()
}

impl State {
    pub fn load() -> Self {
        paths::read_json(&paths::state_path(), Some(Self::default())).unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        paths::write_json_atomic(&paths::state_path(), self)
    }
}

pub fn load_store() -> Store {
    paths::read_json(&paths::store_path(), Some(Store::default())).unwrap_or_default()
}

pub fn save_store(store: &Store) -> Result<(), String> {
    paths::write_json_atomic(&paths::store_path(), store)
}
