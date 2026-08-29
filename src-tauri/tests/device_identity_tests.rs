//! 设备身份（device_id）与 app 数据目录绑定的契约测试。
//!
//! 生产语义：`get_device_id()` 的主路径是 `<app_data_dir>/.device_id`
//! （与数据槽同根，由 DataSpaceManager 提供）。两个不同的 app 数据目录
//! 代表两台"设备"（或同机双实例），它们的 device_id 绝不能相等——
//! 否则云端会把两台设备的变更混在同一个设备目录里，回声过滤会把对方
//! 的上传误判为自己的历史而永久丢弃。
//!
//! `DataSpaceManager` 是进程级 OnceLock 单例，同一进程内无法模拟两个
//! app 数据目录；本文件用**子进程探针**模式：主测试把自身测试二进制
//! 以子进程方式各拉起一次，每个子进程用 `init_data_space_manager`
//! 绑定到不同的临时数据目录后输出 `get_device_id()` 结果。
//!
//! 仅新增测试，不修改生产代码。

use std::path::Path;
use std::process::Command;

/// 子进程探针注入数据目录用的环境变量（仅本测试文件私有约定）。
const PROBE_DATA_DIR_ENV: &str = "DEVICE_ID_PROBE_DATA_DIR";
const PROBE_OUTPUT_PREFIX: &str = "PROBE_DEVICE_ID=";

/// 子进程探针：设置了 `DEVICE_ID_PROBE_DATA_DIR` 时，把数据空间管理器
/// 绑定到该目录并输出 device_id；正常测试运行（无环境变量）时直接通过。
#[test]
fn device_id_probe_subprocess() {
    let Ok(data_dir) = std::env::var(PROBE_DATA_DIR_ENV) else {
        return;
    };
    deep_student_lib::data_space::init_data_space_manager(data_dir.into())
        .expect("探针子进程应能初始化数据空间管理器");
    let id = deep_student_lib::cloud_storage::get_device_id();
    println!("{PROBE_OUTPUT_PREFIX}{id}");
}

/// 在隔离环境下拉起探针子进程，返回其解析出的 device_id。
///
/// 隔离点：
/// - 清除 `DEVICE_ID` 环境变量（生产中它优先于磁盘身份，测试必须走磁盘路径）；
/// - `HOME`/`XDG_DATA_HOME`/`XDG_CONFIG_HOME` 指向共享的隔离目录，防止
///   宿主机上真实存在的 `~/.local/share/deep-student/.device_id` 等旧路径
///   副本泄漏进测试。两个数据目录共享同一 HOME，恰好锁定"身份差异只能
///   来自 app 数据目录本身"。
fn probe_device_id(data_dir: &Path, isolated_home: &Path) -> String {
    let exe = std::env::current_exe().expect("当前测试二进制路径可获取");
    let output = Command::new(exe)
        .args(["device_id_probe_subprocess", "--exact", "--nocapture"])
        .env(PROBE_DATA_DIR_ENV, data_dir)
        .env_remove("DEVICE_ID")
        .env("HOME", isolated_home)
        .env("XDG_DATA_HOME", isolated_home.join("xdg-data"))
        .env("XDG_CONFIG_HOME", isolated_home.join("xdg-config"))
        .output()
        .expect("探针子进程应能启动");
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(
        output.status.success(),
        "探针子进程应成功退出。stdout:\n{stdout}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix(PROBE_OUTPUT_PREFIX))
        .unwrap_or_else(|| panic!("探针子进程未输出 device_id。stdout:\n{stdout}"))
        .to_string()
}

/// 核心契约：两个不同的 app 数据目录必须得到互不相等的 device_id，
/// 且各自的身份都持久化在自己目录下的 `.device_id`，重启（新进程）后
/// 读回同一身份。
#[test]
fn two_app_data_dirs_yield_distinct_persisted_device_ids() {
    let home_guard = tempfile::tempdir().expect("isolated home");
    let dir_a_guard = tempfile::tempdir().expect("app data dir A");
    let dir_b_guard = tempfile::tempdir().expect("app data dir B");
    let (home, dir_a, dir_b) = (home_guard.path(), dir_a_guard.path(), dir_b_guard.path());

    let id_a = probe_device_id(dir_a, home);
    let id_b = probe_device_id(dir_b, home);

    assert!(!id_a.trim().is_empty(), "数据目录 A 的 device_id 不得为空");
    assert!(!id_b.trim().is_empty(), "数据目录 B 的 device_id 不得为空");
    assert_ne!(
        id_a, id_b,
        "两个 app 数据目录（两台设备/双实例）绝不能共享同一 device_id，\
         否则云端回声过滤会把对方的变更当成自己的历史而丢弃"
    );

    // 身份必须落盘在各自数据目录的主路径 `.device_id`，且内容与返回值一致。
    for (dir, id, label) in [(dir_a, &id_a, "A"), (dir_b, &id_b, "B")] {
        let device_id_file = dir.join(".device_id");
        assert!(
            device_id_file.is_file(),
            "数据目录 {label} 下必须持久化 .device_id 文件"
        );
        let on_disk = std::fs::read_to_string(&device_id_file)
            .expect("读取 .device_id")
            .trim()
            .to_string();
        assert_eq!(
            &on_disk, id,
            "数据目录 {label} 落盘的 device_id 必须与运行时返回值一致"
        );
    }

    // 模拟重启：对同一数据目录再起一个新进程，身份必须稳定不变。
    let id_a_again = probe_device_id(dir_a, home);
    assert_eq!(
        id_a, id_a_again,
        "同一 app 数据目录在新进程（重启）中必须读回同一 device_id，身份不得漂移"
    );
}
