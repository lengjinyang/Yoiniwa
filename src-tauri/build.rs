fn main() {
    tauri_build::build();
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
