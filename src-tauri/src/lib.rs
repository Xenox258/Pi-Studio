mod commands;
mod errors;
mod omp;
mod services;
mod state;
mod storage;
mod usage;

use commands::studio::*;
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).max_file_size(4_000_000).build())?;
            }
            let data_dir = app.path().app_data_dir()?;
            let state = AppState::new(&data_dir).map_err(|error| error.to_string())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_omp_capabilities, get_studio_settings, save_studio_settings, runtime_stats, catalog_packages, catalog_marketplaces, add_catalog_marketplace, catalog_readme, available_models, available_providers, open_project, create_project, recent_projects, recent_sessions, set_session_title, start_session, resume_session, stop_session, delete_session, send_prompt, steer_prompt, follow_up_prompt, stop_run, conversation_history, session_configuration, session_snapshot, available_commands,
            set_workflow_mode, set_advisor_enabled, set_model, set_thinking_level, usage_get_snapshot, usage_consume_reset,
            get_role_mappings, save_role_mappings, git_snapshot, github_snapshot, git_diff, read_project_file, provider_login, provider_api_key_login, provider_logout, provider_test, manage_package, read_clipboard_image, load_attachment
        ])
        .build(tauri::generate_context!())
        .expect("error while building OMP Studio");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            let manager = handle.state::<AppState>().manager.clone();
            tauri::async_runtime::spawn(async move { manager.stop_all().await; });
        }
    });
}
