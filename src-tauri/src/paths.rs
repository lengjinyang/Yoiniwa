use std::{fs, path::Path};

pub fn path_key(path: &Path) -> String {
    let absolute = fs::canonicalize(path).or_else(|_| std::path::absolute(path))
        .unwrap_or_else(|_| path.to_path_buf());
    let value = absolute.to_string_lossy();
    #[cfg(windows)]
    { value.strip_prefix(r"\\?\").unwrap_or(&value).replace('\\', "/").to_lowercase() }
    #[cfg(not(windows))]
    { value.into_owned() }
}

pub fn same_path(left: &Path, right: &Path) -> bool { path_key(left) == path_key(right) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn windows_path_aliases_have_one_identity() {
        assert!(same_path(Path::new(r"D:\参考图\Board.yoi"), Path::new("d:/参考图/board.yoi")));
        assert!(same_path(Path::new(r"\\?\D:\参考图\Board.yoi"), Path::new("D:/参考图/Board.yoi")));
        assert!(!same_path(Path::new("D:/参考图/a.yoi"), Path::new("D:/参考图/b.yoi")));
    }
}
