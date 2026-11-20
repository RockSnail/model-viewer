mod models;

use tauri::{DragDropEvent, Emitter, EventTarget, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    models::register_resources(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(models::ModelAccess::default())
        .on_window_event(|window, event| {
            // 主 WebviewWindow 的原生拖放由 Tauri 作为窗口事件分发
            if window.label() == "main"
                && let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event
            {
                if let Some(path) = paths.iter().find(|path| models::supports_model(path)) {
                    window.state::<models::ModelAccess>().allow_model(path);
                }
                // 授权完成后才通知前端加载，避免系统拖放事件和路径授权之间出现竞态
                if let Err(error) = window.emit_to(
                    EventTarget::webview(window.label()),
                    "model-files-dropped",
                    paths,
                ) {
                    eprintln!("无法发送模型拖放事件：{error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            models::pick_model,
            models::pick_texture_folder,
            models::read_model,
            models::model_stamp,
            models::recent_models,
            models::remember_model,
            models::authorize_recent,
            models::save_screenshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
