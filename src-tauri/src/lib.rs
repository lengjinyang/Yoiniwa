#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod asset_protocol;
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
mod video_service;

pub fn run() {
    app::run();
}
