mod models;

use tauri::{DragDropEvent, Emitter, Manager, WebviewEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    models::register_resources(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(models::ModelAccess::default())
        .on_webview_event(|webview, event| {
            if webview.label() == "main"
                && let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event
            {
                if let Some(path) = paths.iter().find(|path| models::supports_model(path)) {
                    webview.state::<models::ModelAccess>().allow_model(path);
                }
                // 授权完成后才通知前端加载，避免系统拖放事件和路径授权之间出现竞态
                let _ = webview.emit_to(webview.label(), "model-files-dropped", paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            models::pick_model,
            models::pick_texture_folder,
            models::read_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
