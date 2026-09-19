//! SFM profile 检视：列出 SFM 的 profile 与本地产物的同源性校验。
//!
//! 尸检 002：SQLite 查询必须先校验 schema 列名，BLOB 不得用于业务推断。
//! 当前激活 profile 无可靠数据源（settings.db 的 selected_profile_id 是
//! 未破译的 GRDB BLOB；面板 API 无 profile 概念；同源 profile 指纹无法区分），
//! 因此本模块只给「同源性」这种可证事实，激活信息仅给 mtime 提示并明示未验证。

use std::path::PathBuf;
use std::process::Command;

/// SFM 数据目录候选（TestFlight 版 / App Store 版）。
const SFM_CONTAINERS: [&str; 2] = [
    "P8XK3KHB48.io.nekohasekai.sfamt",
    "group.io.nekohasekai.sfm",
];

/// profiles 表必需列（来自实测 schema；读取前先与 PRAGMA 校验，缺列即报错）。
const REQUIRED_COLUMNS: [&str; 3] = ["id", "name", "path"];

pub fn sfm_container_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    SFM_CONTAINERS
        .iter()
        .map(|c| PathBuf::from(&home).join("Library/Group Containers").join(c))
        .find(|p| p.join("settings.db").is_file())
}

struct ProfileRow {
    id: String,
    name: String,
    kind: String,
    path: String,
    mtime_epoch: Option<u64>,
}

/// 运行 sqlite3 查询，非零退出或无输出返回 Err。
fn sqlite(db: &PathBuf, sql: &str) -> Result<String, String> {
    let out = Command::new("/usr/bin/sqlite3")
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|e| format!("sqlite3 执行失败: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn read_profiles(db: &PathBuf) -> Result<Vec<ProfileRow>, String> {
    // 尸检 002 规则 1: 列名来自 PRAGMA，不凭记忆写列序
    let schema = sqlite(db, "PRAGMA table_info(profiles)")?;
    let cols: Vec<&str> = schema.lines().filter_map(|l| l.split('|').nth(1)).collect();
    let missing: Vec<String> = REQUIRED_COLUMNS
        .iter()
        .filter(|c| !cols.contains(c))
        .map(|c| c.to_string())
        .collect();
    if !missing.is_empty() {
        return Err(format!("profiles 表缺少必需列: {}", missing.join(", ")));
    }

    // type 枚举实测: 0=local, 2=remote（1 疑似 iCloud，未见样本）
    let rows = sqlite(
        db,
        "SELECT id, name, type, path, lastUpdated FROM profiles ORDER BY id",
    )?;
    let container_mtime = |rel: &str| {
        let p = db.parent()?.join(rel);
        std::fs::metadata(p).ok()?.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
    };
    Ok(rows
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('|').collect();
            if f.len() < 4 {
                return None;
            }
            Some(ProfileRow {
                id: f[0].to_string(),
                name: f[1].to_string(),
                kind: match f[2] {
                    "0" => "local",
                    "2" => "remote",
                    _ => "other",
                }
                .to_string(),
                path: f[3].to_string(),
                mtime_epoch: container_mtime(f[3]),
            })
        })
        .collect())
}

/// 归一化指纹: 排除 experimental 段（SFM 保存时会重写该段）后序列化哈希。
fn fingerprint(v: &serde_json::Value) -> String {
    let mut v = v.clone();
    if let Some(obj) = v.as_object_mut() {
        obj.remove("experimental");
    }
    format!("{:x}", md5_of_json(&v))
}

/// 轻量 json 规范化哈希（排序键），避免引入额外依赖。
fn md5_of_json(v: &serde_json::Value) -> u64 {
    // FNV-1a 足够区分同源差异，不用于安全场景
    fn fnv(s: &[u8]) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in s {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    }
    fn walk(v: &serde_json::Value, out: &mut Vec<u8>) {
        match v {
            serde_json::Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort();
                for k in keys {
                    out.extend_from_slice(k.as_bytes());
                    out.push(0);
                    walk(&m[k], out);
                }
            }
            serde_json::Value::Array(a) => {
                for item in a {
                    walk(item, out);
                }
            }
            other => out.extend_from_slice(other.to_string().as_bytes()),
        }
    }
    let mut buf = Vec::new();
    walk(v, &mut buf);
    fnv(&buf)
}

fn fmt_ts() -> String {
    String::new()
}

pub fn run(target: Option<&str>) -> Result<(), String> {
    let container = sfm_container_dir()
        .ok_or("未找到 SFM 数据目录（TestFlight / App Store 版均不存在）")?;
    let db = container.join("settings.db");
    let profiles = read_profiles(&db)?;

    let output = crate::store::load_store()
        .output
        .map(PathBuf::from)
        .unwrap_or_else(crate::paths::output_path);
    let product: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&output).map_err(|e| format!("产物不可读: {e}"))?,
    )
    .map_err(|e| format!("产物解析失败: {e}"))?;
    let product_fp = fingerprint(&product);

    println!("SFM 目录: {}", container.display());
    println!("产物: {}（指纹 {product_fp:.16}）", output.display());
    println!();
    println!("profiles:");
    let mut hint: Option<&ProfileRow> = None;
    for p in &profiles {
        let file = container.join(&p.path);
        let (fp, sync_mark) = match std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            Some(v) if v == serde_json::json!({}) => ("空配置".to_string(), ""),
            Some(v) => {
                let f = fingerprint(&v);
                let mark = if f == product_fp { "← 与产物同源" } else { "" };
                (format!("{f:.16}"), mark)
            }
            None => ("-".to_string(), ""),
        };
        let mtime = p
            .mtime_epoch
            .map(|e| sqlite(&db, &format!("SELECT datetime({e}, 'unixepoch', 'localtime')")).unwrap_or_default())
            .filter(|s| !s.is_empty());
        let mtext = mtime.unwrap_or_else(fmt_ts);
        println!(
            "  [{id}] {name} ({kind})  {path}  修改 {mtext}  指纹 {fp}{sync_mark}",
            id = p.id,
            name = p.name,
            kind = p.kind,
            path = p.path,
        );
        if p.kind == "local" && hint.map_or(true, |h| h.mtime_epoch < p.mtime_epoch) {
            hint = Some(p);
        }
    }
    if let Some(h) = hint {
        println!();
        println!(
            "激活提示: 最近修改的 local profile 是 [{id}] {name}。未验证是否为当前激活项（无可靠数据源），请以 SFM 菜单为准",
            id = h.id,
            name = h.name
        );
    }
    if let Some(t) = target {
        let file = container.join(t);
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&file).map_err(|e| format!("目标 profile 不可读: {e}"))?,
        )
        .map_err(|e| format!("目标 profile 解析失败: {e}"))?;
        if fingerprint(&v) == product_fp {
            println!("同源校验: {t} 与产物一致");
        } else {
            println!("同源校验: {t} 与产物不一致（SFM experimental 段差异已排除）");
            std::process::exit(1);
        }
    }
    Ok(())
}
