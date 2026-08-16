use std::str::FromStr;

use anyhow::{anyhow, Result};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const FALLBACK_SHORTCUT: &str = "Ctrl+Alt+Shift+Y";
pub const DEFAULT_COLLABORATION_SHORTCUT: &str = "Ctrl+Alt+Y";

pub fn replace_collaboration_shortcut(app: &AppHandle, previous: &str, next: &str) -> Result<()> {
    let previous = Shortcut::from_str(previous).map_err(|error| anyhow!("无效旧快捷键: {error}"))?;
    let next = Shortcut::from_str(next).map_err(|error| anyhow!("无效快捷键: {error}"))?;
    if app.global_shortcut().is_registered(next) {
        return Err(anyhow!("快捷键已被其他应用占用"));
    }
    app.global_shortcut().register(next)?;
    if previous != next {
        let _ = app.global_shortcut().unregister(previous);
    }
    Ok(())
}

pub(crate) fn valid_collaboration_shortcut(value: &str) -> bool {
    if value.len() > 80 || value == FALLBACK_SHORTCUT {
        return false;
    }
    let parts = value.split('+').collect::<Vec<_>>();
    let Some(key) = parts.last().copied().filter(|key| !key.is_empty()) else {
        return false;
    };
    let modifiers = &parts[..parts.len() - 1];
    if !modifiers.iter().any(|part| matches!(*part, "Ctrl" | "Alt"))
        || modifiers
            .iter()
            .any(|part| !matches!(*part, "Ctrl" | "Alt" | "Shift"))
        || ["Ctrl", "Alt", "Shift"].iter().any(|modifier| {
            modifiers.iter().filter(|part| *part == modifier).count() > 1
        })
    {
        return false;
    }
    (key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()))
        || key
            .strip_prefix('F')
            .and_then(|number| number.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number))
        || matches!(
            key,
            "Tab"
                | "Space"
                | "Delete"
                | "Escape"
                | "ArrowUp"
                | "ArrowDown"
                | "ArrowLeft"
                | "ArrowRight"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ctrl_or_alt_letter_shortcuts() {
        assert!(valid_collaboration_shortcut("Ctrl+Alt+Y"));
        assert!(valid_collaboration_shortcut("Alt+F8"));
        assert!(valid_collaboration_shortcut("Ctrl+Shift+1"));
    }

    #[test]
    fn rejects_fallback_and_modifier_only_chords() {
        assert!(!valid_collaboration_shortcut(FALLBACK_SHORTCUT));
        assert!(!valid_collaboration_shortcut("Y"));
        assert!(!valid_collaboration_shortcut("Ctrl+Ctrl+Y"));
        assert!(!valid_collaboration_shortcut("Shift+Y"));
    }
}
