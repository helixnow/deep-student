// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(windows)]
    if let Some(exit_code) = deep_student_lib::chat_v2::tools::shell_sandbox::maybe_run_helper() {
        std::process::exit(exit_code);
    }

    deep_student_lib::run()
}
