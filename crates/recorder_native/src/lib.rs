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
    #[serde(default)]
    params: Vec<String>,
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

// ── Value types (deserialized from JS) ───────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodedValue {
    value: serde_json::Value,
    type_kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValueEntry {
    event_index: usize,
    #[serde(default)]
    args: Option<Vec<EncodedValue>>,
    #[serde(default)]
    return_value: Option<EncodedValue>,
}

/// A write entry deserialized from the JS side (console output).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteEntryInput {
    event_index: usize,
    kind: String,
    content: String,
}

// ── TraceLowLevelEvent-compatible types (serialized to JSON) ─────────
//
// These types mirror the `codetracer_trace_types` crate's serialization
// format exactly, so the db-backend can deserialize traces produced by
// the JS recorder without any conversion layer.

/// Mirrors `codetracer_trace_types::TypeKind` — serialized as `repr(u8)`.
///
/// We only define the variants the JS recorder can produce.
/// Values match the discriminants in the upstream enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
enum TypeKind {
    Seq = 0,
    Struct = 6,
    Int = 7,
    Float = 8,
    String = 9,
    Bool = 11,
    Raw = 15,
    FunctionKind = 22,
    None = 27,
}

impl Serialize for TypeKind {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl TypeKind {
    fn from_str(s: &str) -> Self {
        match s {
            "Int" => TypeKind::Int,
            "Float" => TypeKind::Float,
            "String" => TypeKind::String,
            "Bool" => TypeKind::Bool,
            "Seq" => TypeKind::Seq,
            "Struct" => TypeKind::Struct,
            "FunctionKind" => TypeKind::FunctionKind,
            "None" => TypeKind::None,
            _ => TypeKind::Raw,
        }
    }
}

/// Mirrors `codetracer_trace_types::EventLogKind` — serialized as `repr(u8)`.
#[derive(Debug, Clone, Copy)]
#[repr(u8)]
enum EventLogKind {
    Write = 0,
}

impl Serialize for EventLogKind {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

/// Mirrors `codetracer_trace_types::TypeSpecificInfo`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum TypeSpecificInfo {
    None,
    Struct { fields: Vec<FieldTypeRecord> },
}

/// Mirrors `codetracer_trace_types::FieldTypeRecord`.
#[derive(Debug, Clone, Serialize)]
struct FieldTypeRecord {
    name: String,
    type_id: usize,
}

/// Mirrors `codetracer_trace_types::TypeRecord`.
#[derive(Debug, Clone, Serialize)]
struct TypeRecord {
    kind: TypeKind,
    lang_type: String,
    specific_info: TypeSpecificInfo,
}

/// Mirrors `codetracer_trace_types::StepRecord`.
#[derive(Debug, Clone, Serialize)]
struct StepRecord {
    path_id: usize,
    line: i64,
}

/// Mirrors `codetracer_trace_types::FunctionRecord`.
#[derive(Debug, Clone, Serialize)]
struct FunctionRecord {
    path_id: usize,
    line: i64,
    name: String,
}

/// Mirrors `codetracer_trace_types::CallRecord`.
#[derive(Debug, Clone, Serialize)]
struct CallRecord {
    function_id: usize,
    #[serde(default)]
    args: Vec<FullValueRecord>,
}

/// Mirrors `codetracer_trace_types::ReturnRecord`.
#[derive(Debug, Clone, Serialize)]
struct ReturnRecord {
    return_value: ValueRecord,
}

/// Mirrors `codetracer_trace_types::RecordEvent`.
#[derive(Debug, Clone, Serialize)]
struct RecordEvent {
    kind: EventLogKind,
    metadata: String,
    content: String,
}

/// Mirrors `codetracer_trace_types::FullValueRecord`.
#[derive(Debug, Clone, Serialize)]
struct FullValueRecord {
    variable_id: usize,
    value: ValueRecord,
}

/// Mirrors `codetracer_trace_types::ValueRecord`.
///
/// Uses `#[serde(tag = "kind")]` internally tagged, matching upstream.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ValueRecord {
    Int {
        i: i64,
        type_id: usize,
    },
    Float {
        f: String,
        type_id: usize,
    },
    Bool {
        b: bool,
        type_id: usize,
    },
    String {
        text: String,
        type_id: usize,
    },
    Struct {
        field_values: Vec<ValueRecord>,
        field_names: Vec<String>,
        type_id: usize,
    },
    Sequence {
        elements: Vec<ValueRecord>,
        is_slice: bool,
        type_id: usize,
    },
    Raw {
        r: String,
        type_id: usize,
    },
    None {
        type_id: usize,
    },
}

/// Mirrors `codetracer_trace_types::TraceLowLevelEvent`.
///
/// Uses serde's default externally-tagged enum representation, matching upstream.
#[derive(Debug, Clone, Serialize)]
enum TraceEvent {
    Path(PathBuf),
    VariableName(String),
    Type(TypeRecord),
    Function(FunctionRecord),
    Step(StepRecord),
    Call(CallRecord),
    Return(ReturnRecord),
    Event(RecordEvent),
    Value(FullValueRecord),
    ThreadStart(u64),
    ThreadSwitch(u64),
    ThreadExit(u64),
}

// ── Trace metadata ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct TraceMetadata {
    language: String,
    program: String,
    args: Vec<String>,
    recorder: String,
    format: String,
    workdir: String,
}

// ── Type registry ───────────────────────────────────────────────────

/// Tracks registered types so we emit each TypeKind only once and reuse
/// the type_id for value records.
struct TypeRegistry {
    /// Maps TypeKind discriminant -> type_id (index into the type table).
    map: HashMap<u8, usize>,
    next_id: usize,
}

impl TypeRegistry {
    fn new() -> Self {
        TypeRegistry {
            map: HashMap::new(),
            next_id: 0,
        }
    }

    /// Get or register a type, returning (type_id, optional TraceEvent::Type to emit).
    fn get_or_register(&mut self, kind: TypeKind) -> (usize, Option<TraceEvent>) {
        let disc = kind as u8;
        if let Some(&id) = self.map.get(&disc) {
            (id, None)
        } else {
            let id = self.next_id;
            self.next_id += 1;
            self.map.insert(disc, id);
            let lang_type = match kind {
                TypeKind::Int => "number",
                TypeKind::Float => "number",
                TypeKind::String => "string",
                TypeKind::Bool => "boolean",
                TypeKind::Seq => "array",
                TypeKind::Struct => "object",
                TypeKind::FunctionKind => "function",
                TypeKind::Raw => "raw",
                TypeKind::None => "undefined",
            };
            let event = TraceEvent::Type(TypeRecord {
                kind,
                lang_type: lang_type.to_string(),
                specific_info: TypeSpecificInfo::None,
            });
            (id, Some(event))
        }
    }
}

/// Tracks registered variable names so we emit VariableName events and
/// map names to variable_id indices.
struct VariableNameRegistry {
    map: HashMap<String, usize>,
    next_id: usize,
}

impl VariableNameRegistry {
    fn new() -> Self {
        VariableNameRegistry {
            map: HashMap::new(),
            next_id: 0,
        }
    }

    /// Get or register a variable name, returning (variable_id, optional TraceEvent::VariableName to emit).
    fn get_or_register(&mut self, name: &str) -> (usize, Option<TraceEvent>) {
        if let Some(&id) = self.map.get(name) {
            (id, None)
        } else {
            let id = self.next_id;
            self.next_id += 1;
            self.map.insert(name.to_string(), id);
            (id, Some(TraceEvent::VariableName(name.to_string())))
        }
    }
}

// ── Recorder state ──────────────────────────────────────────────────

struct RecorderState {
    trace_dir: PathBuf,
    manifest: Manifest,
    events: Vec<TraceEvent>,
    program: String,
    args: Vec<String>,
    format: String,
    type_registry: TypeRegistry,
    var_name_registry: VariableNameRegistry,
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

/// Convert an EncodedValue (from JS) to a ValueRecord (TraceLowLevelEvent-compatible).
fn encoded_to_value_record(
    ev: &EncodedValue,
    type_registry: &mut TypeRegistry,
    pending_events: &mut Vec<TraceEvent>,
) -> ValueRecord {
    let kind = TypeKind::from_str(&ev.type_kind);
    let (type_id, type_event) = type_registry.get_or_register(kind);
    if let Some(te) = type_event {
        pending_events.push(te);
    }

    match kind {
        TypeKind::Int => {
            let i = ev.value.as_i64().unwrap_or(0);
            ValueRecord::Int { i, type_id }
        }
        TypeKind::Float => {
            let f = ev.value.as_f64().unwrap_or(0.0);
            ValueRecord::Float {
                f: f.to_string(),
                type_id,
            }
        }
        TypeKind::Bool => {
            let b = ev.value.as_bool().unwrap_or(false);
            ValueRecord::Bool { b, type_id }
        }
        TypeKind::String => {
            let text = ev.value.as_str().unwrap_or("").to_string();
            ValueRecord::String { text, type_id }
        }
        TypeKind::Seq => {
            let elements = if let Some(arr) = ev.value.as_array() {
                arr.iter()
                    .map(|item| {
                        // Each item in a sequence should have typeKind + value
                        if let Some(obj) = item.as_object() {
                            let inner_kind = obj
                                .get("typeKind")
                                .and_then(|v| v.as_str())
                                .unwrap_or("Raw");
                            let inner_value =
                                obj.get("value").cloned().unwrap_or(serde_json::Value::Null);
                            let inner_ev = EncodedValue {
                                value: inner_value,
                                type_kind: inner_kind.to_string(),
                            };
                            encoded_to_value_record(&inner_ev, type_registry, pending_events)
                        } else {
                            // Bare value - treat as raw
                            let (raw_tid, raw_te) = type_registry.get_or_register(TypeKind::Raw);
                            if let Some(te) = raw_te {
                                pending_events.push(te);
                            }
                            ValueRecord::Raw {
                                r: item.to_string(),
                                type_id: raw_tid,
                            }
                        }
                    })
                    .collect()
            } else {
                vec![]
            };
            ValueRecord::Sequence {
                elements,
                is_slice: false,
                type_id,
            }
        }
        TypeKind::Struct => {
            let mut field_values: Vec<ValueRecord> = Vec::new();
            let mut field_names: Vec<String> = Vec::new();
            if let Some(obj) = ev.value.as_object() {
                if let Some(fields) = obj.get("fields").and_then(|f| f.as_array()) {
                    for field in fields {
                        if let Some(field_obj) = field.as_object() {
                            let name = field_obj
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string();
                            let value = match field_obj.get("value") {
                                Some(v) => v,
                                None => continue,
                            };
                            // For nested structs/sequences, the value contains
                            // {typeKind, value} structure; for simple types it's
                            // just a plain JSON value.
                            let record = if let Some(inner_obj) = value.as_object() {
                                if inner_obj.contains_key("typeKind") {
                                    // It's a nested encoded value
                                    let nested_ev = EncodedValue {
                                        value: inner_obj
                                            .get("value")
                                            .cloned()
                                            .unwrap_or(serde_json::Value::Null),
                                        type_kind: inner_obj
                                            .get("typeKind")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Raw")
                                            .to_string(),
                                    };
                                    encoded_to_value_record(
                                        &nested_ev,
                                        type_registry,
                                        pending_events,
                                    )
                                } else {
                                    // Regular object value -- serialize as raw
                                    let (raw_tid, raw_te) =
                                        type_registry.get_or_register(TypeKind::Raw);
                                    if let Some(te) = raw_te {
                                        pending_events.push(te);
                                    }
                                    ValueRecord::Raw {
                                        r: value.to_string(),
                                        type_id: raw_tid,
                                    }
                                }
                            } else {
                                let inner_kind = field_obj
                                    .get("typeKind")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Raw");
                                let field_ev = EncodedValue {
                                    value: value.clone(),
                                    type_kind: inner_kind.to_string(),
                                };
                                encoded_to_value_record(&field_ev, type_registry, pending_events)
                            };
                            field_names.push(name);
                            field_values.push(record);
                        }
                    }
                }
            }
            ValueRecord::Struct {
                field_values,
                field_names,
                type_id,
            }
        }
        TypeKind::FunctionKind => {
            let text = match &ev.value {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            ValueRecord::Raw { r: text, type_id }
        }
        TypeKind::None => ValueRecord::None { type_id },
        TypeKind::Raw => {
            let r = match &ev.value {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => "<null>".to_string(),
                other => other.to_string(),
            };
            ValueRecord::Raw { r, type_id }
        }
    }
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
            format!("Failed to parse manifest JSON: {e}"),
        )
    })?;

    // Allocate a handle
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::SeqCst);

    // Create trace directory
    let trace_dir = Path::new(&out_dir).join(format!("trace-{handle}"));
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

    let mut type_registry = TypeRegistry::new();
    let var_name_registry = VariableNameRegistry::new();

    // Pre-register paths and functions as initial events
    let mut events: Vec<TraceEvent> = Vec::new();

    for p in &manifest.paths {
        events.push(TraceEvent::Path(PathBuf::from(p)));
    }

    // Register types that functions may reference — emit Type events
    // before Function events so the db-backend has them available.
    // We pre-register a few common types.
    for kind in [
        TypeKind::None,
        TypeKind::Int,
        TypeKind::Float,
        TypeKind::String,
        TypeKind::Bool,
        TypeKind::Raw,
        TypeKind::Seq,
        TypeKind::Struct,
        TypeKind::FunctionKind,
    ] {
        let (_id, type_event) = type_registry.get_or_register(kind);
        if let Some(te) = type_event {
            events.push(te);
        }
    }

    for f in &manifest.functions {
        events.push(TraceEvent::Function(FunctionRecord {
            path_id: f.path_index,
            line: f.line as i64,
            name: f.name.clone(),
        }));
    }

    let state = RecorderState {
        trace_dir,
        manifest,
        events,
        program,
        args,
        format,
        type_registry,
        var_name_registry,
    };

    recorder_map()
        .lock()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Lock poisoned: {e}")))?
        .insert(handle, state);

    Ok(handle)
}

#[napi]
pub fn append_events(
    handle: u32,
    event_kinds: napi::bindgen_prelude::Uint8Array,
    ids: napi::bindgen_prelude::Uint32Array,
    values_json: String,
    writes_json: Option<String>,
) -> Result<()> {
    let mut map = recorder_map()
        .lock()
        .map_err(|e| Error::new(Status::GenericFailure, format!("Lock poisoned: {e}")))?;

    let state = map.get_mut(&handle).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid recorder handle: {handle}"),
        )
    })?;

    // Parse values JSON — an array of ValueEntry objects
    let value_entries: Vec<ValueEntry> = if values_json.is_empty() || values_json == "[]" {
        vec![]
    } else {
        serde_json::from_str(&values_json).unwrap_or_default()
    };

    // Parse writes JSON — an array of WriteEntryInput objects
    let write_entries: Vec<WriteEntryInput> = match &writes_json {
        Some(json) if !json.is_empty() && json != "[]" => {
            serde_json::from_str(json).unwrap_or_default()
        }
        _ => vec![],
    };

    // Build a lookup: event_index -> ValueEntry for quick access
    let mut value_map: HashMap<usize, &ValueEntry> = HashMap::new();
    for entry in &value_entries {
        value_map.insert(entry.event_index, entry);
    }

    // Build a lookup: event_index -> WriteEntryInput for quick access
    let mut write_map: HashMap<usize, &WriteEntryInput> = HashMap::new();
    for entry in &write_entries {
        write_map.insert(entry.event_index, entry);
    }

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
                    state.events.push(TraceEvent::Step(StepRecord {
                        path_id: site.path_index,
                        line: site.line as i64,
                    }));
                }
            }
            // enter (call)
            1 => {
                let mut pending_events: Vec<TraceEvent> = Vec::new();
                let args = if let Some(entry) = value_map.get(&i) {
                    if let Some(ref encoded_args) = entry.args {
                        // Get parameter names from manifest
                        let param_names = state
                            .manifest
                            .functions
                            .get(id)
                            .map(|f| &f.params)
                            .cloned()
                            .unwrap_or_default();

                        encoded_args
                            .iter()
                            .enumerate()
                            .map(|(j, ev)| {
                                let name = param_names
                                    .get(j)
                                    .cloned()
                                    .unwrap_or_else(|| format!("_param{j}"));
                                let (var_id, var_event) =
                                    state.var_name_registry.get_or_register(&name);
                                if let Some(ve) = var_event {
                                    pending_events.push(ve);
                                }
                                let value = encoded_to_value_record(
                                    ev,
                                    &mut state.type_registry,
                                    &mut pending_events,
                                );
                                FullValueRecord {
                                    variable_id: var_id,
                                    value,
                                }
                            })
                            .collect()
                    } else {
                        vec![]
                    }
                } else {
                    vec![]
                };

                // Emit any pending type/variable-name events before the Call event
                state.events.extend(pending_events);
                state.events.push(TraceEvent::Call(CallRecord {
                    function_id: id,
                    args,
                }));
            }
            // ret (return)
            2 => {
                let mut pending_events: Vec<TraceEvent> = Vec::new();
                let return_value = if let Some(entry) = value_map.get(&i) {
                    if let Some(rv) = &entry.return_value {
                        encoded_to_value_record(rv, &mut state.type_registry, &mut pending_events)
                    } else {
                        let (none_tid, none_te) =
                            state.type_registry.get_or_register(TypeKind::None);
                        if let Some(te) = none_te {
                            pending_events.push(te);
                        }
                        ValueRecord::None { type_id: none_tid }
                    }
                } else {
                    let (none_tid, none_te) = state.type_registry.get_or_register(TypeKind::None);
                    if let Some(te) = none_te {
                        pending_events.push(te);
                    }
                    ValueRecord::None { type_id: none_tid }
                };

                state.events.extend(pending_events);
                state
                    .events
                    .push(TraceEvent::Return(ReturnRecord { return_value }));
            }
            // write (console output) -> Event(RecordEvent)
            3 => {
                if let Some(write_entry) = write_map.get(&i) {
                    // Map JS write kinds to EventLogKind
                    let _kind = match write_entry.kind.as_str() {
                        "stdout" | "stderr" | "log" | "warn" | "error" | "info" | "debug" => {
                            EventLogKind::Write
                        }
                        _ => EventLogKind::Write,
                    };
                    state.events.push(TraceEvent::Event(RecordEvent {
                        kind: EventLogKind::Write,
                        metadata: write_entry.kind.clone(),
                        content: write_entry.content.clone(),
                    }));
                }
            }
            // thread_start (new async context)
            4 => {
                state.events.push(TraceEvent::ThreadStart(id as u64));
            }
            // thread_switch (execution moved to a different async context)
            5 => {
                state.events.push(TraceEvent::ThreadSwitch(id as u64));
            }
            // thread_exit (async context completed)
            6 => {
                state.events.push(TraceEvent::ThreadExit(id as u64));
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
        .map_err(|e| Error::new(Status::GenericFailure, format!("Lock poisoned: {e}")))?;

    let state = map.remove(&handle).ok_or_else(|| {
        Error::new(
            Status::InvalidArg,
            format!("Invalid recorder handle: {handle}"),
        )
    })?;

    // Write trace.json
    let trace_json = serde_json::to_string_pretty(&state.events).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize trace events: {e}"),
        )
    })?;
    fs::write(state.trace_dir.join("trace.json"), &trace_json).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write trace.json: {e}"),
        )
    })?;

    // Write trace_metadata.json
    let workdir = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let metadata = TraceMetadata {
        language: "javascript".to_string(),
        program: state.program,
        args: state.args,
        recorder: "codetracer-js-recorder".to_string(),
        format: state.format,
        workdir,
    };
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize metadata: {e}"),
        )
    })?;
    fs::write(state.trace_dir.join("trace_metadata.json"), &metadata_json).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write trace_metadata.json: {e}"),
        )
    })?;

    // Write trace_paths.json
    let paths_json = serde_json::to_string_pretty(&state.manifest.paths).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to serialize paths: {e}"),
        )
    })?;
    fs::write(state.trace_dir.join("trace_paths.json"), &paths_json).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to write trace_paths.json: {e}"),
        )
    })?;

    // Copy source files to files/ directory
    let files_dir = state.trace_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create files directory: {e}"),
        )
    })?;

    for source_path in &state.manifest.paths {
        // Preserve directory structure inside files/.
        // Strip leading '/' from absolute paths so join() doesn't replace the base.
        let relative = source_path.strip_prefix('/').unwrap_or(source_path);
        // On Windows, also strip leading drive letters like "D:\" so join() works.
        let relative = relative
            .get(1..)
            .filter(|_| relative.as_bytes().get(1) == Some(&b':'))
            .map(|s| {
                s.strip_prefix('\\')
                    .or_else(|| s.strip_prefix('/'))
                    .unwrap_or(s)
            })
            .unwrap_or(relative);
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
