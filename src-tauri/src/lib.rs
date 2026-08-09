#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod assets;
mod bridge;
mod image_pipeline;
mod native;
mod photoshop;
mod project;
mod state;
mod types;

pub fn run() {
    app::run();
}
