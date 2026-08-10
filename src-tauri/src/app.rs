use std::{str::FromStr, thread, time::Duration};

use anyhow::{anyhow, Result};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{bridge, state::AppState};

const FALLBACK_SHORTCUT: &str = "Ctrl+Alt+Shift+Y";
const CLICK_THROUGH_ESCAPE: &str = "Ctrl+Alt+Shift+T";
const DEFAULT_COLLABORATION_SHORTCUT: &str = "Ctrl+Alt+Y";

pub fn run() {
    let args = std::env::args().collect::<Vec<_>>();
    let startup_path = args.iter().find(|value| value.to_ascii_lowercase().ends_with(".yoi") || value.to_ascii_lowercase().ends_with(".refcanvas")).cloned();
    let startup_for_setup = startup_path.clone();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, shortcut, event| {
            if event.state != ShortcutState::Pressed { return; }
            let state = app.state::<AppState>();
            let accelerator = shortcut.to_string();
            if shortcut_matches(&accelerator, CLICK_THROUGH_ESCAPE) { state.native.disable_click_through(); }
            else { state.native.toggle_collaboration_requested(); }
        }).build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = argv.iter().find(|value| value.to_ascii_lowercase().ends_with(".yoi") || value.to_ascii_lowercase().ends_with(".refcanvas")) {
                if let Some(state) = app.try_state::<AppState>() { state.set_startup_path(path.clone()); }
                let _ = app.emit("scene:external-open", path.clone());
            }
            if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus(); }
        }))
        .register_asynchronous_uri_scheme_protocol("refcanvas-asset", |context, request, responder| {
            let assets = context.app_handle().state::<AppState>().assets.clone();
            std::thread::spawn(move || {
                responder.respond(assets.protocol_response(&request));
            });
        })
        .setup(move |app| {
            let state = AppState::new(app.handle(), startup_for_setup.clone())?;
            let persisted = state.read_persisted_state();
            let requested_shortcut = persisted.get("shortcuts").and_then(|value| value.get("collaboration")).and_then(|value| value.as_str())
                .filter(|value| valid_collaboration_shortcut(value)).unwrap_or(DEFAULT_COLLABORATION_SHORTCUT);
            state.native.set_shortcut_value(requested_shortcut.to_string());
            let native = state.native.clone();
            app.manage(state);
            native.start_helper()?;
            native.set_shortcut_value(register_shortcuts(app.handle(), &native.shortcut()));
            let appearance = native.clone();
            thread::spawn(move || appearance.apply_flat_appearance());
            let photoshop = app.state::<AppState>().photoshop.clone();
            thread::spawn(move || photoshop.warm());
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| handle_window_event(&handle, event));
                main.show()?;
                main.set_focus()?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::images_import, bridge::images_register_paths, bridge::images_register_urls,
            bridge::images_register_clipboard, bridge::images_start_native_drag, bridge::images_prewarm,
            bridge::images_cancel_prewarm, bridge::images_boost_resource, bridge::images_performance_stats,
            bridge::images_sample_pixel, bridge::project_open, bridge::project_commit, bridge::project_save_as,
            bridge::project_close, bridge::project_compact, bridge::project_stats, bridge::project_recover,
            bridge::scene_startup_path, bridge::scene_recent, bridge::scene_import,
            bridge::cache_info, bridge::cache_choose_location, bridge::cache_reset_location, bridge::cache_clear,
            bridge::image_export, bridge::image_export_originals, bridge::image_copy, bridge::image_copy_original, bridge::image_show_source,
            bridge::photoshop_set_foreground, bridge::photoshop_place_rendered, bridge::photoshop_place_rendered_layers,
            bridge::photoshop_open_rendered, bridge::photoshop_get_document_info, bridge::photoshop_capture_preview,
            bridge::photoshop_take_preview,
            bridge::photoshop_create_version, bridge::photoshop_open_version, bridge::photoshop_delete_version,
            bridge::window_set_mode, bridge::window_get_mode, bridge::window_get_work_area,
            bridge::window_get_collaboration_shortcut, bridge::window_set_collaboration_shortcut,
            bridge::window_is_key_down, bridge::window_set_title, bridge::window_minimize,
            bridge::window_toggle_maximize, bridge::window_move_start, bridge::window_move_update,
            bridge::window_move_end, bridge::window_close, bridge::window_close_response, bridge::window_dirty,
            bridge::taskbar_pen_start, bridge::taskbar_pen_pointer,
            bridge::logs_write, bridge::logs_open_folder, bridge::logs_copy_diagnostics, bridge::logs_recent_problems,
            bridge::performance_record_manual_wheel,
        ]);

    let app = builder.build(tauri::generate_context!()).expect("Yoiniwa Tauri initialization failed");
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(state) = app.try_state::<AppState>() {
                state.native.shutdown();
                let _ = state.project.lock().close(None);
            }
        }
    });
}

fn handle_window_event(app: &tauri::AppHandle, event: &WindowEvent) {
    let state = app.state::<AppState>();
    match event {
        WindowEvent::CloseRequested { api, .. } if state.native.should_intercept_close() => {
            api.prevent_close(); state.native.request_close_prompt();
        }
        WindowEvent::Focused(false) => {
            let native = state.native.clone();
            thread::spawn(move || { thread::sleep(Duration::from_millis(80)); native.repair_after_blur(); });
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            state.native.sync_pen_windows();
        }
        _ => {}
    }
}

fn register_shortcuts(app: &tauri::AppHandle, collaboration: &str) -> String {
    for shortcut in [CLICK_THROUGH_ESCAPE, FALLBACK_SHORTCUT] {
        if let Ok(parsed) = Shortcut::from_str(shortcut) {
            if !app.global_shortcut().is_registered(parsed) { let _ = app.global_shortcut().register(parsed); }
        }
    }
    for candidate in [collaboration, DEFAULT_COLLABORATION_SHORTCUT] {
        let Ok(parsed) = Shortcut::from_str(candidate) else { continue; };
        if app.global_shortcut().is_registered(parsed) || app.global_shortcut().register(parsed).is_ok() {
            return candidate.to_string();
        }
    }
    DEFAULT_COLLABORATION_SHORTCUT.to_string()
}

pub fn replace_collaboration_shortcut(app: &tauri::AppHandle, previous: &str, next: &str) -> Result<()> {
    let previous = Shortcut::from_str(previous).map_err(|error| anyhow!("无效旧快捷键: {error}"))?;
    let next = Shortcut::from_str(next).map_err(|error| anyhow!("无效快捷键: {error}"))?;
    if app.global_shortcut().is_registered(next) { return Err(anyhow!("快捷键已被其他应用占用")); }
    app.global_shortcut().register(next)?;
    if previous != next { let _ = app.global_shortcut().unregister(previous); }
    Ok(())
}

fn shortcut_matches(actual: &str, expected: &str) -> bool {
    normalize_shortcut(actual) == normalize_shortcut(expected)
}
fn normalize_shortcut(value: &str) -> String { value.replace("Control", "Ctrl").replace(' ', "").to_ascii_lowercase() }

pub(crate) fn valid_collaboration_shortcut(value: &str) -> bool {
    if value.len() > 80 || value == FALLBACK_SHORTCUT { return false; }
    let parts = value.split('+').collect::<Vec<_>>();
    let Some(key) = parts.last().copied().filter(|key| !key.is_empty()) else { return false; };
    let modifiers = &parts[..parts.len() - 1];
    if !modifiers.iter().any(|part| matches!(*part, "Ctrl" | "Alt"))
        || modifiers.iter().any(|part| !matches!(*part, "Ctrl" | "Alt" | "Shift"))
        || ["Ctrl", "Alt", "Shift"].iter().any(|modifier| modifiers.iter().filter(|part| *part == modifier).count() > 1) {
        return false;
    }
    (key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
        || key.strip_prefix('F').and_then(|number| number.parse::<u8>().ok()).is_some_and(|number| (1..=24).contains(&number))
        || matches!(key, "Tab" | "Space" | "Delete" | "Escape" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight")
}
