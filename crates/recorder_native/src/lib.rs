#[macro_use]
extern crate napi_derive;

use napi::{bindgen_prelude::*, JsObject};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

// ── Manifest types (deserialized from JSON) ─────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestFunction {
    name: String,
    path_index: usize,
    line: u32,
    #[allow(dead_code)]
    col: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSite {
    #[allow(dead_code)]
    kind: String,
    path_index: usize,
    line: u32,
    #[allow(dead_code)]
    col: u32,
    #[allow(dead_code)]
    fn_id: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[allow(dead_code)]
    format_version: u32,
    paths: Vec<String>,
    functions: Vec<ManifestFunction>,
    sites: Vec<ManifestSite>,
    #[serde(default)]
    sources_content: HashMap<String, String>,
}

// ── Trace event types (serialized to JSON) ──────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum TraceEvent {
    Path {
        path: String,
    },
    Function {
        name: String,
        #[serde(rename = "pathIndex")]
        path_index: usize,
        line: u32,
    },
    Step {
        #[serde(rename = "pathIndex")]
        path_index: usize,
        line: u32,
    },
    Call {
        #[serde(rename = "fnId")]
        fn_id: usize,
        args: Vec<serde_json::Value>,
    },
    Return {},
}

// ── Trace metadata ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct TraceMetadata {
    language: String,
    program: String,
    args: Vec<String>,
    recorder: String,
    format: String,
}

// ── Recorder state ──────────────────────────────────────────────────

struct RecorderState {
    trace_dir: PathBuf,
    manifest: Manifest,
    events: Vec<TraceEvent>,
    program: String,
    args: Vec<String>,
    format: String,
}

// Global handle counter
static NEXT_HANDLE: AtomicU32 = AtomicU32::new(1);

// We use a simple global mutex-protected HashMap for handle management.
// This is fine for the expected usage pattern (one recorder per process).
fn recorder_map() -> &'static Mutex<HashMap<u32, RecorderState>> {
    use std::sync::OnceLock;
    static MAP: OnceLock<Mutex<HashMap<u32, RecorderState>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── N-API exports ───────────────────────────────────────────────────

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn start_recording(opts: JsObject) -> Result<u32> {
    // Extract fields from the options object
    let out_dir: String = opts
        .get_named_property::<napi::JsString>("outDir")?
        .into_utf8()?
        .as_str()?
        .to_string();
    let program: String = opts
        .get_named_property::<napi::JsString>("program")?
        .into_utf8()?
        .as_str()?
        .to_string();

    let args_obj: napi::JsObject = opts.get_named_property("args")?;
    let args_len = args_obj.get_array_length().unwrap_or(0);
    let mut args: Vec<String> = Vec::with_capacity(args_len as usize);
    for i in 0..args_len {
        let val: napi::JsString = args_obj.get_element(i)?;
        args.push(val.into_utf8()?.as_str()?.to_string());
    }

    let manifest_json: String = opts
        .get_named_property::<napi::JsString>("manifestJson")?
        .into_utf8()?
        .as_str()?
        .to_string();
    let format: String = opts
        .get_named_property::<napi::JsString>("format")?
        .into_utf8()?
        .as_str()?
        .to_string();

    // Parse manifest
    let manifest: Manifest = serde_json::from_str(&manifest_json).map_err(|e| {
        Error::new(
            Status::InvalidArg,
            format!("Failed to parse manifest JSON: {}", e),
        )
    })?;

    // Allocate a handle
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);

    // Create trace directory
    let trace_dir = Path::new(&out_dir).join(format!("trace-{}", handle));
    fs::create_dir_all(&trace_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!(
                "Failed to create trace directory {}: {}",
                trace_dir.display(),
                e
            ),
        )
    })?;

    // Pre-register paths and functions as initial events
    let mut events: Vec<TraceEvent> = Vec::new();

    for p in &manifest.paths {
        events.push(TraceEvent::Path { path: p.clone() });
    }

    for f in &manifest.functions {
        events.push(TraceEvent::Function {
            name: f.name.clone(),
            path_index: f.path_index,
            line: f.line,
        });
    }

    let state = RecorderState {
        trace_dir,
        manifest,
        events,
        program,
        args,
        format,
    };

    recorder_map()
        .lock()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Lock poisoned: {}", e)))?
        .insert(handle, state);

    Ok(handle)
}

#[napi]
pub fn append_events(
    handle: u32,
    event_kinds: napi::bindgen_prelude::Uint8Array,
    ids: napi::bindgen_prelude::Uint32Array,
) -> Result<()> {
    let mut map = recorder_map()
        .lock()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Lock poisoned: {}", e)))?;

    let state = map.get_mut(&handle).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid recorder handle: {}", handle),
        )
    })?;

    let kinds = event_kinds.as_ref();
    let id_vals = ids.as_ref();
    let len = kinds.len().min(id_vals.len());

    for i in 0..len {
        let kind = kinds[i];
        let id = id_vals[i] as usize;

        match kind {
            // step
            0 => {
                if let Some(site) = state.manifest.sites.get(id) {
                    state.events.push(TraceEvent::Step {
                        path_index: site.path_index,
                        line: site.line,
                    });
                }
            }
            // enter
            1 => {
                state.events.push(TraceEvent::Call {
                    fn_id: id,
                    args: vec![],
                });
            }
            // ret
            2 => {
                state.events.push(TraceEvent::Return {});
            }
            _ => {
                // Unknown event kind — skip
            }
        }
    }

    Ok(())
}

#[napi]
pub fn flush_and_stop(handle: u32) -> Result<String> {
    let mut map = recorder_map()
        .lock()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Lock poisoned: {}", e)))?;

    let state = map.remove(&handle).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid recorder handle: {}", handle),
        )
    })?;

    // Write trace.json
    let trace_json = serde_json::to_string_pretty(&state.events).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize trace events: {}", e),
        )
    })?;
    fs::write(state.trace_dir.join("trace.json"), &trace_json).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write trace.json: {}", e),
        )
    })?;

    // Write trace_metadata.json
    let metadata = TraceMetadata {
        language: "javascript".to_string(),
        program: state.program,
        args: state.args,
        recorder: "codetracer-js-recorder".to_string(),
        format: state.format,
    };
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize metadata: {}", e),
        )
    })?;
    fs::write(state.trace_dir.join("trace_metadata.json"), &metadata_json).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write trace_metadata.json: {}", e),
        )
    })?;

    // Write trace_paths.json
    let paths_json = serde_json::to_string_pretty(&state.manifest.paths).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize paths: {}", e),
        )
    })?;
    fs::write(state.trace_dir.join("trace_paths.json"), &paths_json).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write trace_paths.json: {}", e),
        )
    })?;

    // Copy source files to files/ directory
    let files_dir = state.trace_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create files directory: {}", e),
        )
    })?;

    for source_path in &state.manifest.paths {
        // Preserve directory structure inside files/.
        // Strip leading '/' from absolute paths so join() doesn't replace the base.
        let relative = source_path.strip_prefix('/').unwrap_or(source_path);
        let dest = files_dir.join(relative);
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }

        // First check sourcesContent from the manifest (from source maps),
        // then fall back to reading from the filesystem.
        if let Some(content) = state.manifest.sources_content.get(source_path) {
            let _ = fs::write(&dest, content);
        } else {
            let src = Path::new(source_path);
            if src.exists() {
                let _ = fs::copy(src, &dest);
            }
        }
    }

    Ok(state.trace_dir.to_string_lossy().to_string())
}
