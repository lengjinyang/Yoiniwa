#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod assets;
mod bridge;
mod diagnostics;
mod image_jobs;
mod image_pipeline;
mod native;
mod photoshop;
mod project;
mod state;
mod types;
mod video_meta;
mod video_poster;
mod video_proxy;

pub fn run() {
    app::run();
}
