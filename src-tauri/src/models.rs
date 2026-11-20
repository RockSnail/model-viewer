use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use tauri::{AppHandle, Manager, State, Url, http, ipc::Response};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct ModelAccess {
    models: Mutex<HashSet<PathBuf>>,
    folders: Mutex<HashSet<PathBuf>>,
}

pub fn supports_model(path: &Path) -> bool {
    matches!(extension(path).as_str(), "glb" | "fbx")
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

impl ModelAccess {
    pub fn allow_model(&self, path: &Path) {
        if supports_model(path) {
            if let Ok(canonical) = fs::canonicalize(path) {
                self.models.lock().unwrap().insert(canonical);
            }
        }
    }

    fn model_path(&self, path: &Path) -> Option<PathBuf> {
        if !supports_model(path) {
            return None;
        }
        let canonical = fs::canonicalize(path).ok()?;
        self.models
            .lock()
            .unwrap()
            .contains(&canonical)
            .then_some(canonical)
    }
}

#[tauri::command]
pub async fn pick_model(app: AppHandle) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_title("打开模型")
            .add_filter("3D 模型", &["glb", "fbx"])
            .blocking_pick_file();
        let path = selection
            .map(|value| value.into_path())
            .transpose()
            .map_err(|e| e.to_string())?;
        if let Some(path) = &path {
            app.state::<ModelAccess>().allow_model(path);
        }
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pick_texture_folder(app: AppHandle) -> Result<Option<PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_title("选择贴图目录")
            .blocking_pick_folder();
        let Some(path) = selection else {
            return Ok(None);
        };
        let path = path.into_path().map_err(|e| e.to_string())?;
        let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
        app.state::<ModelAccess>()
            .folders
            .lock()
            .unwrap()
            .insert(canonical);
        Ok(Some(path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_model(access: State<'_, ModelAccess>, path: PathBuf) -> Result<Response, String> {
    let path = access.model_path(&path).ok_or("文件不存在或未授权读取")?;
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

fn find_resource(access: &ModelAccess, url: &Url) -> Option<(Vec<u8>, &'static str)> {
    let mut query = url.query_pairs();
    let model = query.find(|(key, _)| key == "model")?.1;
    let resource = url
        .query_pairs()
        .find(|(key, _)| key == "resource")?
        .1
        .replace('\\', "/");
    let folder = url
        .query_pairs()
        .find(|(key, _)| key == "folder")
        .map(|(_, value)| value);
    let model = access.model_path(Path::new(model.as_ref()))?;
    let model_dir = model.parent()?;
    let folder = folder
        .and_then(|path| fs::canonicalize(path.as_ref()).ok())
        .filter(|path| access.folders.lock().unwrap().contains(path));
    let relative = Path::new(&resource);
    let name = Path::new(relative.file_name()?);
    let content_type = match extension(name).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "tga" | "bin" => "application/octet-stream",
        _ => return None,
    };

    // 首选模型目录，再查用户选定的目录；规范化后阻止链接或路径跳出目录
    for dir in std::iter::once(model_dir).chain(folder.as_deref()) {
        let safe_relative = relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
        let candidate = if safe_relative { relative } else { name };
        for file in [candidate, name] {
            if let Ok(path) = fs::canonicalize(dir.join(file)) {
                if path.starts_with(dir) && path.is_file() {
                    if let Ok(bytes) = fs::read(path) {
                        return Some((bytes, content_type));
                    }
                }
            }
        }
    }
    None
}

pub fn register_resources(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        "model-resource",
        |context, request, responder| {
            let app = context.app_handle().clone();
            let main_window = context.webview_label() == "main";
            tauri::async_runtime::spawn_blocking(move || {
                let origin = request
                    .headers()
                    .get(http::header::ORIGIN)
                    .and_then(|value| value.to_str().ok());
                let allowed = origin.is_none_or(|value| {
                    matches!(
                        value,
                        "http://localhost:1420"
                            | "http://tauri.localhost"
                            | "https://tauri.localhost"
                            | "tauri://localhost"
                    )
                });
                let result = if main_window && allowed && request.method() == http::Method::GET {
                    Url::parse(&request.uri().to_string())
                        .ok()
                        .and_then(|url| find_resource(&app.state(), &url))
                } else {
                    None
                };
                let mut response =
                    http::Response::builder().header(http::header::CACHE_CONTROL, "no-store");
                if let Some(origin) = origin.filter(|_| allowed) {
                    response = response.header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
                }
                responder.respond(if let Some((bytes, kind)) = result {
                    response
                        .header(http::header::CONTENT_TYPE, kind)
                        .body(bytes)
                        .unwrap()
                } else {
                    response
                        .status(http::StatusCode::NOT_FOUND)
                        .body(Vec::new())
                        .unwrap()
                });
            });
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_lookup_respects_selected_model_and_folder() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/models");
        let model = fixtures.join("外部贴图.fbx");
        let alternate_model = fixtures.join("../..").join("src-tauri/Cargo.toml");
        let access = ModelAccess::default();
        let mut url = Url::parse("http://model-resource.localhost/resource").unwrap();
        url.query_pairs_mut()
            .append_pair("model", model.to_str().unwrap())
            .append_pair("resource", "棋盘.png");

        assert!(find_resource(&access, &url).is_none());
        access.allow_model(&model);
        assert_eq!(find_resource(&access, &url).unwrap().1, "image/png");
        assert!(access.model_path(&alternate_model).is_none());

        // 新目录中仅放模型，确保缺失贴图只能由明确选择的目录补齐
        let missing_dir = fixtures
            .join("../../src-tauri/target")
            .join(format!("model-resource-test-{}", std::process::id()));
        fs::create_dir_all(&missing_dir).unwrap();
        let missing_model = missing_dir.join("缺贴图.FBX");
        fs::copy(model, &missing_model).unwrap();
        access.allow_model(&missing_model);
        url.set_query(None);
        url.query_pairs_mut()
            .append_pair("model", missing_model.to_str().unwrap())
            .append_pair("resource", "棋盘.png")
            .append_pair("folder", fixtures.to_str().unwrap());
        let before_selection = find_resource(&access, &url);
        access
            .folders
            .lock()
            .unwrap()
            .insert(fs::canonicalize(&fixtures).unwrap());
        let after_selection = find_resource(&access, &url);
        fs::remove_file(&missing_model).unwrap();
        fs::remove_dir(&missing_dir).unwrap();
        assert!(before_selection.is_none());
        assert_eq!(
            after_selection.unwrap().0,
            fs::read(fixtures.join("棋盘.png")).unwrap()
        );
    }
}
