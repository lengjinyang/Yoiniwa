fn main() {
    println!("cargo:rerun-if-changed=../build/yoiniwa.ico");
    tauri_build::build();
    if std::env::var("TARGET").is_ok_and(|target| target.ends_with("windows-msvc")) {
        // Unit-test executables also import TaskDialogIndirect, which requires Common Controls v6.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // Tauri already embeds the main executable's manifest in resource.lib.
        println!("cargo:rustc-link-arg-bin=yoiniwa=/MANIFEST:NO");
    }
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    println!("cargo:rustc-link-search=native={}", manifest.join("vendor/libvips").display());
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        if let Some(profile_dir) = std::path::Path::new(&out_dir).ancestors().nth(3) {
            let _ = std::fs::copy(manifest.join("vendor/libvips/libvips-42.dll"), profile_dir.join("libvips-42.dll"));
        }
    }
    println!("cargo:rerun-if-changed=vendor/libvips/libvips-42.dll");
    println!("cargo:rerun-if-changed=vendor/libvips/vips.def");
    println!("cargo:rerun-if-changed=resources/native-window-move.ps1");
    println!("cargo:rerun-if-changed=resources/photoshop-color-bridge.ps1");
    println!("cargo:rerun-if-changed=resources/photoshop-focus-bridge.ps1");
    println!("cargo:rerun-if-changed=resources/photoshop-document-bridge.ps1");
}
