// MPV Player Abstraction Layer
// 
// This module provides a unified interface for MPV player across platforms:
// - macOS: Uses tauri-plugin-libmpv for proper window embedding
// - Windows/Linux: Uses sidecar MPV process with JSON IPC
//
// Both approaches expose the same API to the frontend.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod sidecar;
#[cfg(not(target_os = "macos"))]
pub use sidecar::*;
