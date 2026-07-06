#[macro_use]
extern crate napi_derive;

use napi::{bindgen_prelude::*, JsObject};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

// Nim-backed binary trace writer (produces .ct files).
// We alias the upstream types to avoid name clashes with the local mirror types.
use codetracer_trace_writer_nim::{NimTraceWriter, TraceEventsFileFormat as NimTraceFormat};

#[cfg(test)]
mod shared_trace_storage_adapter_tests {
    use codetracer_ctfs::trace_storage::{
        ManagedTraceSender, ManagedUploadKind, ManagedUploadObject, ManagedUploadReceipt,
        SenderError, SenderHealth, SharedSenderBackend, TraceStorageConfig, TRACE_STORAGE_SCHEMA,
    };

    #[test]
    fn javascript_recorder_binds_shared_trace_storage_config() {
        let config = TraceStorageConfig::from_json(include_str!(
            "../../../../codetracer-trace-format/codetracer_ctfs/tests/fixtures/trace_storage/storage_config.full.json"
        ))
        .expect("shared trace-storage fixture parses through codetracer_ctfs");

        assert_eq!(config.schema, TRACE_STORAGE_SCHEMA);
        assert_eq!(config.storage_servers.len(), 2);
        assert_eq!(config.retention.delete_after_days, 90);
    }

    #[derive(Default)]
    struct JavascriptBindingBackend {
        uploaded: Vec<String>,
    }

    impl SharedSenderBackend for JavascriptBindingBackend {
        fn upload_slice(
            &mut self,
            object: &ManagedUploadObject,
        ) -> Result<ManagedUploadReceipt, SenderError> {
            self.upload(object)
        }

        fn upload_materialized_artifact(
            &mut self,
            object: &ManagedUploadObject,
        ) -> Result<ManagedUploadReceipt, SenderError> {
            self.upload(object)
        }

        fn upload_manifest(
            &mut self,
            object: &ManagedUploadObject,
        ) -> Result<ManagedUploadReceipt, SenderError> {
            self.upload(object)
        }

        fn finalize(
            &mut self,
            _request: &codetracer_ctfs::trace_storage::ManagedFinalizeRequest,
        ) -> Result<(), SenderError> {
            Ok(())
        }

        fn health(&self) -> SenderHealth {
            SenderHealth {
                healthy: true,
                message: "javascript binding backend".to_string(),
            }
        }
    }

    impl JavascriptBindingBackend {
        fn upload(
            &mut self,
            object: &ManagedUploadObject,
        ) -> Result<ManagedUploadReceipt, SenderError> {
            self.uploaded.push(object.object_key.clone());
            Ok(ManagedUploadReceipt {
                object_key: object.object_key.clone(),
                storage_pool_id: "shared-local".to_string(),
                storage_server_id: "local-storage-1".to_string(),
                storage_endpoint_uri: "local://codetracer-ci/storage-service".to_string(),
            })
        }
    }

    #[test]
    fn javascript_recorder_uses_shared_managed_sender_for_materialized_artifacts() {
        let mut sender =
            ManagedTraceSender::new(JavascriptBindingBackend::default(), "javascript-finalize");
        sender
            .upload_materialized_artifact(ManagedUploadObject {
                object_key: "traces/tenant/javascript/materialized-trace-v1.json".to_string(),
                local_path: "/tmp/javascript/materialized-trace-v1.json".to_string(),
                content_length: 256,
                sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_string(),
                kind: ManagedUploadKind::MaterializedArtifact {
                    artifact_kind: "materialized_trace_v1".to_string(),
                },
            })
            .unwrap();
        assert_eq!(sender.backend().uploaded.len(), 1);
    }
}

// Historical note: this file used to define `#[no_mangle]` stub
// implementations of `trace_writer_register_return_cbor`,
// `trace_writer_register_variable_cbor` and `ct_value_write_error` because
// the upstream Nim library did not yet export those symbols.  They are now
// real exports of `libcodetracer_trace_writer.a` (see
// codetracer-trace-format-nim `multi_stream_writer.nim`), so the stubs
// would collide with the canonical implementations at link time and were
// removed.  The Nim implementations are the canonical CBOR-encoded value
// path used by `register_call_arg`, `register_variable_with_full_value`,
// and `register_return` for compound values.

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
    kind: String,
    path_index: usize,
    line: u32,
    /// P2.1: column offset for this site.  Sourced from
    /// `loc.start.column` (SWC byte offset within the line, 0-based).
    /// Read by the column-aware step-emission cursor in
    /// `append_events` to fold into `DeltaColumn` events.  When the
    /// manifest predates P2 the field defaults to `0` (the canonical
    /// "no column information available" sentinel).
    #[serde(default)]
    col: u32,
    #[allow(dead_code)]
    fn_id: Option<usize>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    rvalue_kind: Option<String>,
    #[serde(default)]
    rvalue_source: Option<String>,
    #[serde(default)]
    rvalue_field: Option<String>,
    #[serde(default)]
    rvalue_index: Option<i64>,
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
    /// P2.3: per-source line-length tables keyed by source path.  Each
    /// entry is the byte-length-per-line array used to populate the
    /// CTFS `paths.dat` Layout A line-length record (see
    /// `codetracer-trace-format-spec/trace-events.md` §"paths.dat
    /// per-line offset table — Layout A").  Defaults to empty when
    /// the manifest predates P2 — the writer falls back to the
    /// bare-path `register_path` record and the column-aware reader
    /// surfaces `column = None` for those files.
    #[serde(default)]
    line_lengths: HashMap<String, Vec<u32>>,
    /// P6.2: additional files to materialise under `<trace>/files/`
    /// beyond the entries in `paths`.  Keyed by absolute virtual
    /// path (same encoding as `paths`), value is the file contents.
    ///
    /// Populated by `packages/cli/src/record-cmd.ts` when the
    /// recorder-side autoformat pass produces a formatted sibling
    /// (`<file>.fmt.js`) and its V3 sourcemap (`<file>.fmt.js.map`).
    /// Replay-server's existing P3 sourcemap discovery (sibling
    /// `.map` lookup) picks these up at trace-open time — no
    /// replay-time subprocess.
    ///
    /// Defaults to empty when the manifest predates P6.2 — the
    /// addon falls through to the legacy copy-only behaviour.
    #[serde(default)]
    extra_files: HashMap<String, String>,
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
    #[serde(default)]
    assignment_value: Option<EncodedValue>,
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
///
/// Only the variants the JS recorder actually emits are listed.  Discriminants
/// match the upstream `codetracer_trace_types::EventLogKind` so the JSON
/// trace's numeric `kind` survives round-tripping through db-backend.
#[derive(Debug, Clone, Copy)]
#[repr(u8)]
enum EventLogKind {
    /// `Write` — stdout-style program output (console.log / console.info).
    Write = 0,
    /// `WriteOther` — stderr-style program output (console.warn / console.error).
    WriteOther = 2,
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
    // The Struct variant mirrors upstream `codetracer_trace_types::TypeSpecificInfo`
    // for serialization-shape completeness. The JS recorder doesn't currently emit
    // it because its type registry encodes struct shapes via the parent
    // `TypeKind::Struct` discriminator + the value record's own `field_values` array,
    // but the variant is kept so the on-disk enum tag layout matches the canonical
    // crate byte-for-byte (consumers may serde-deserialize through this enum).
    #[allow(dead_code)]
    Struct {
        fields: Vec<FieldTypeRecord>,
    },
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
///
/// P2.2: `column` is `Some(c)` when the upstream Babel/SWC manifest
/// carried a column offset for this site, `None` otherwise.  Column
/// numbering is 1-based on the wire (the canonical CTFS
/// `DeltaColumn` writer applies the +1 conversion); the manifest
/// stores SWC's 0-based offset.  When `column_aware` mode is off
/// the field is ignored by `write_binary_trace` and the writer takes
/// the legacy `register_step` path.
#[derive(Debug, Clone, Serialize)]
struct StepRecord {
    path_id: usize,
    line: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    column: Option<i64>,
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
    // The Value variant mirrors upstream `codetracer_trace_types::TraceEvent`
    // for tag-discriminator completeness. The JS recorder doesn't emit standalone
    // Value events because every step bundles its values inline; the variant is
    // kept so a serde-deserialiser walking this enum sees the canonical tag layout.
    #[allow(dead_code)]
    Value(FullValueRecord),
    Assignment(codetracer_trace_types::AssignmentRecord),
    ThreadStart(u64),
    ThreadSwitch(u64),
    ThreadExit(u64),
}

// Trace metadata previously serialised to `trace_metadata.json` is now
// embedded in `meta.dat` by the CTFS writer; the sidecar struct was
// retired with the v3 rollout.

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

fn assignment_rvalue_from_site(
    site: &ManifestSite,
    registry: &mut VariableNameRegistry,
    pending_events: &mut Vec<TraceEvent>,
) -> codetracer_trace_types::RValue {
    let mut variable_id_for = |name: &str| {
        let (id, var_event) = registry.get_or_register(name);
        if let Some(ve) = var_event {
            pending_events.push(ve);
        }
        codetracer_trace_types::VariableId(id)
    };

    match site.rvalue_kind.as_deref().unwrap_or("Compound") {
        "Literal" => codetracer_trace_types::RValue::Literal,
        "Simple" => site
            .rvalue_source
            .as_deref()
            .map(&mut variable_id_for)
            .map(codetracer_trace_types::RValue::Simple)
            .unwrap_or_else(|| codetracer_trace_types::RValue::Compound(Vec::new())),
        "FieldAccess" => match (site.rvalue_source.as_deref(), site.rvalue_field.as_ref()) {
            (Some(source), Some(field)) => codetracer_trace_types::RValue::FieldAccess {
                receiver: variable_id_for(source),
                field: field.clone(),
            },
            _ => codetracer_trace_types::RValue::Compound(Vec::new()),
        },
        "IndexAccess" => match (site.rvalue_source.as_deref(), site.rvalue_index) {
            (Some(source), Some(index)) => codetracer_trace_types::RValue::IndexAccess {
                receiver: variable_id_for(source),
                index,
            },
            _ => codetracer_trace_types::RValue::Compound(Vec::new()),
        },
        "FunctionReturn" => {
            // The JS runtime currently reports assignment writes as
            // `EVENT_ASSIGNMENT(site_id, target_value)` with no link to the
            // immediately preceding/underlying call event.  Call keys are
            // allocated inside the Nim trace writer when `register_call` is
            // replayed, so this native buffering layer cannot safely name the
            // call record whose return value flowed into this assignment.
            // Emitting `FunctionReturn { CallKey(0) }` is therefore actively
            // misleading: it points every call/new/tagged-template assignment
            // at the same synthetic call.  Until the runtime carries a stable
            // call-event identity through the assignment side channel, keep the
            // rvalue conservative and let the captured target Value event carry
            // the concrete result.
            codetracer_trace_types::RValue::Compound(Vec::new())
        }
        _ => site
            .rvalue_source
            .as_deref()
            .map(&mut variable_id_for)
            .map(|id| codetracer_trace_types::RValue::Compound(vec![id]))
            .unwrap_or_else(|| codetracer_trace_types::RValue::Compound(Vec::new())),
    }
}

#[cfg(test)]
mod assignment_rvalue_tests {
    use super::*;

    fn write_site(target: &str, rvalue_kind: &str) -> ManifestSite {
        ManifestSite {
            kind: "write".to_string(),
            path_index: 0,
            line: 1,
            col: 0,
            fn_id: None,
            target: Some(target.to_string()),
            rvalue_kind: Some(rvalue_kind.to_string()),
            rvalue_source: None,
            rvalue_field: None,
            rvalue_index: None,
        }
    }

    #[test]
    fn function_return_assignment_rvalue_does_not_fabricate_call_key_zero() {
        let site = write_site("result", "FunctionReturn");
        let mut registry = VariableNameRegistry::new();
        let mut pending_events = Vec::new();

        let rvalue = assignment_rvalue_from_site(&site, &mut registry, &mut pending_events);

        match rvalue {
            codetracer_trace_types::RValue::Compound(ids) => assert!(ids.is_empty()),
            codetracer_trace_types::RValue::FunctionReturn { call_key } => {
                panic!("function-return assignment used bogus call key {call_key:?}")
            }
            other => panic!("unexpected conservative function-return rvalue: {other:?}"),
        }
        assert!(pending_events.is_empty());
    }

    #[test]
    fn simple_assignment_rvalue_registers_source_variable() {
        let mut site = write_site("b", "Simple");
        site.rvalue_source = Some("a".to_string());
        let mut registry = VariableNameRegistry::new();
        let mut pending_events = Vec::new();

        let rvalue = assignment_rvalue_from_site(&site, &mut registry, &mut pending_events);

        match rvalue {
            codetracer_trace_types::RValue::Simple(codetracer_trace_types::VariableId(id)) => {
                assert_eq!(id, 0);
            }
            other => panic!("expected Simple rvalue for direct assignment, got {other:?}"),
        }
        assert_eq!(pending_events.len(), 1);
        match &pending_events[0] {
            TraceEvent::VariableName(name) => assert_eq!(name, "a"),
            other => panic!("expected source VariableName event, got {other:?}"),
        }
    }
}

// ── Recorder state ──────────────────────────────────────────────────

struct RecorderState {
    trace_dir: PathBuf,
    manifest: Manifest,
    events: Vec<TraceEvent>,
    program: String,
    /// Original command-line arguments.  Kept for diagnostic purposes;
    /// the trace itself ships argv through the CTFS `meta.dat` block.
    #[allow(dead_code)]
    args: Vec<String>,
    type_registry: TypeRegistry,
    var_name_registry: VariableNameRegistry,
    /// P2.6: when true, the writer is opted into column-aware step
    /// encoding at trace-flush time.  Defaults to true; gated by the
    /// `columnAware` field of the `startRecording` options object
    /// (which itself is wired through the runtime's
    /// `StartRecordingOptions.columnAware` flag and the CLI's
    /// `--column-aware` / `--no-column-aware` toggle).
    column_aware: bool,
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
    // The recorder is CTFS-only (Recorder-CLI-Conventions.md §4) — there is
    // no `format` parameter on the addon's `startRecording` call.

    // P2.6: column-aware opt-in.  Defaults to `true` per the milestone
    // spec.  The TypeScript runtime (`StartRecordingOptions`) passes
    // the resolved boolean unconditionally, but JS callers that bypass
    // the runtime (custom integrations) can omit the field — we
    // honour the spec default in that case.
    let column_aware: bool = opts
        .get_named_property::<napi::JsUnknown>("columnAware")
        .ok()
        .and_then(|v| v.coerce_to_bool().ok())
        .map(|b| b.get_value().unwrap_or(true))
        .unwrap_or(true);

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
        type_registry,
        var_name_registry,
        column_aware,
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
                    // P2.2: forward the SWC byte offset (0-based) to the
                    // step record.  The column-aware writer pass below
                    // converts the offset to a 1-based column when it
                    // emits the canonical `DeltaColumn` event (tag 0x07).
                    // The manifest's `col` is `0` when the site predates
                    // P2 — we surface that as `None` to preserve the
                    // line-only step shape downstream readers expect from
                    // pre-P2 traces.
                    let column = if state.column_aware {
                        Some(site.col as i64)
                    } else {
                        None
                    };
                    state.events.push(TraceEvent::Step(StepRecord {
                        path_id: site.path_index,
                        line: site.line as i64,
                        column,
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

                // Anchor the call entry on the function's DEFINITION line.
                //
                // The trace-format `entryStep` convention (see
                // `codetracer-trace-format-nim`, MultiStreamTraceWriter.registerCall)
                // records a call entry at `stepCount - 1` — i.e. the step that was
                // most recently flushed BEFORE the call.  ct-print then resolves
                // that step index back to a source line to populate the call
                // record's `entry_step`.
                //
                // The SWC instrumenter emits `__ct.step(callSite)` at the *call
                // site* and only emits the callee's first body step AFTER
                // `__ct.enter`.  Without an intervening step, the call entry would
                // therefore anchor on the caller's line, not the callee's
                // definition — the same defect previously seen in the Python
                // recorder.  Downstream consumers (e.g. function-level incremental
                // rebuild) expect the call's recorded line to be the function
                // DEFINITION line, matching the Ruby recorder, whose `:call`
                // tracepoint fires at the method-definition line and emits
                // `register_step(def_line)` immediately before `register_call`
                // (see codetracer-ruby-recorder ext/native_tracer/src/lib.rs).
                //
                // Mirror that contract here: emit a Step at the callee's
                // definition line/col right before the Call so `entryStep`
                // resolves to the definition line for every callee, including
                // leaf functions with no further body steps.
                if let Some(func) = state.manifest.functions.get(id) {
                    let column = if state.column_aware {
                        Some(func.col as i64)
                    } else {
                        None
                    };
                    state.events.push(TraceEvent::Step(StepRecord {
                        path_id: func.path_index,
                        line: func.line as i64,
                        column,
                    }));
                }

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
                    // Map JS console-write kinds to EventLogKind.  stdout-style
                    // sinks (`console.log`, `console.info` — tagged "stdout"
                    // by io-capture.ts) become `Write`; stderr-style sinks
                    // (`console.warn`, `console.error` — tagged "stderr")
                    // become `WriteOther`.  This matches the canonical Python
                    // / Ruby recorder mapping (see handoff entry 1.27 for the
                    // Python `register_special_event` pattern).
                    let kind = match write_entry.kind.as_str() {
                        "stderr" | "warn" | "error" => EventLogKind::WriteOther,
                        _ => EventLogKind::Write,
                    };
                    state.events.push(TraceEvent::Event(RecordEvent {
                        kind,
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
            // assignment write site
            7 => {
                let Some(site) = state.manifest.sites.get(id).cloned() else {
                    continue;
                };
                if site.kind != "write" {
                    continue;
                }
                let Some(target) = site.target.as_deref() else {
                    continue;
                };

                let mut pending_events: Vec<TraceEvent> = Vec::new();
                let (target_id, var_event) = state.var_name_registry.get_or_register(target);
                if let Some(ve) = var_event {
                    pending_events.push(ve);
                }

                let value = value_map
                    .get(&i)
                    .and_then(|entry| entry.assignment_value.as_ref())
                    .map(|encoded| {
                        encoded_to_value_record(
                            encoded,
                            &mut state.type_registry,
                            &mut pending_events,
                        )
                    });

                let rvalue = assignment_rvalue_from_site(
                    &site,
                    &mut state.var_name_registry,
                    &mut pending_events,
                );

                state.events.extend(pending_events);
                if let Some(value) = value {
                    state.events.push(TraceEvent::Value(FullValueRecord {
                        variable_id: target_id,
                        value,
                    }));
                }
                state.events.push(TraceEvent::Assignment(
                    codetracer_trace_types::AssignmentRecord {
                        to: codetracer_trace_types::VariableId(target_id),
                        pass_by: codetracer_trace_types::PassBy::Value,
                        from: rvalue,
                    },
                ));
            }
            _ => {
                // Unknown event kind — skip
            }
        }
    }

    Ok(())
}

// ── Nim trace writer integration ────────────────────────────────────
//
// These helpers convert the JS recorder's local mirror types to the
// upstream `codetracer_trace_types` types consumed by `NimTraceWriter`.

/// Map the local `TypeKind` discriminant to the upstream `codetracer_trace_types::TypeKind`.
///
/// The local enum uses explicit `repr(u8)` discriminants that were intended
/// to match upstream, but some values diverge (Bool, Raw, FunctionKind, None).
/// This function maps by *semantic meaning*, not by numeric value.
fn local_type_kind_to_upstream(k: TypeKind) -> codetracer_trace_types::TypeKind {
    match k {
        TypeKind::Seq => codetracer_trace_types::TypeKind::Seq,
        TypeKind::Struct => codetracer_trace_types::TypeKind::Struct,
        TypeKind::Int => codetracer_trace_types::TypeKind::Int,
        TypeKind::Float => codetracer_trace_types::TypeKind::Float,
        TypeKind::String => codetracer_trace_types::TypeKind::String,
        TypeKind::Bool => codetracer_trace_types::TypeKind::Bool,
        TypeKind::Raw => codetracer_trace_types::TypeKind::Raw,
        TypeKind::FunctionKind => codetracer_trace_types::TypeKind::FunctionKind,
        TypeKind::None => codetracer_trace_types::TypeKind::None,
    }
}

/// Convert a local `ValueRecord` to an upstream `codetracer_trace_types::ValueRecord`,
/// using the `NimTraceWriter` to allocate type IDs on the fly.
fn local_value_to_upstream(
    local: &ValueRecord,
    writer: &mut NimTraceWriter,
) -> codetracer_trace_types::ValueRecord {
    match local {
        ValueRecord::Int { i, type_id: _ } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::Int, "number");
            codetracer_trace_types::ValueRecord::Int {
                i: *i,
                type_id: tid,
            }
        }
        ValueRecord::Float { f, type_id: _ } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::Float, "number");
            // Parse back to f64 — the local type stores the float as a String
            let fval = f.parse::<f64>().unwrap_or(0.0);
            codetracer_trace_types::ValueRecord::Float {
                f: fval,
                type_id: tid,
            }
        }
        ValueRecord::Bool { b, type_id: _ } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::Bool, "boolean");
            codetracer_trace_types::ValueRecord::Bool {
                b: *b,
                type_id: tid,
            }
        }
        ValueRecord::String { text, type_id: _ } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::String, "string");
            codetracer_trace_types::ValueRecord::String {
                text: text.clone(),
                type_id: tid,
            }
        }
        ValueRecord::Struct {
            field_values: _,
            field_names: _,
            type_id: _,
        } => {
            // The Nim C library does not yet export CBOR-based compound value
            // registration functions (trace_writer_register_*_cbor). Until
            // those are available, we flatten compound types to a Raw string
            // representation. This loses structural detail but is safe and
            // matches the `_raw` FFI path.
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::Struct, "object");
            codetracer_trace_types::ValueRecord::Raw {
                r: "{...}".to_string(),
                type_id: tid,
            }
        }
        ValueRecord::Sequence {
            elements: _,
            is_slice: _,
            type_id: _,
        } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::Seq, "array");
            codetracer_trace_types::ValueRecord::Raw {
                r: "[...]".to_string(),
                type_id: tid,
            }
        }
        ValueRecord::Raw { r, type_id: _ } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::Raw, "raw");
            codetracer_trace_types::ValueRecord::Raw {
                r: r.clone(),
                type_id: tid,
            }
        }
        ValueRecord::None { type_id: _ } => {
            let tid = writer.ensure_type_id(codetracer_trace_types::TypeKind::None, "undefined");
            codetracer_trace_types::ValueRecord::None { type_id: tid }
        }
    }
}

/// Replay the collected `TraceEvent` list through a `NimTraceWriter` to
/// produce a CTFS multi-stream `.ct` container in the given output
/// directory.
///
/// This writes three stream files (metadata, events, paths) plus the
/// final `.ct` container via `writer.close()`.  The writer is hard-pinned
/// to `NimTraceFormat::Binary` (the underlying Nim writer treats this as
/// CTFS — see `codetracer_trace_writer_nim/src/lib.rs:297`).  Per
/// `Recorder-CLI-Conventions.md` §4 the recorder is CTFS-only — there is
/// no JSON output dispatch.
///
/// Returns the set of `manifest.extra_files` keys that were successfully
/// migrated into the canonical CTFS `srcviews.dat` stream (P6.2 →
/// canonical migration).  Callers MUST skip materialising these keys
/// under `<trace>/files/` so the sidecar and the srcviews record don't
/// fight over the same content.  Other `extra_files` entries (anything
/// not part of the autoformat pair) remain caller-owned and still need
/// to be written to `<trace>/files/`.
fn write_binary_trace(
    state: &RecorderState,
    trace_dir: &Path,
) -> std::result::Result<std::collections::HashSet<String>, Box<dyn std::error::Error>> {
    let mut writer = NimTraceWriter::new(&state.program, &state.args, NimTraceFormat::Binary);

    // Set the working directory for the trace metadata.
    let workdir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    writer.set_workdir(&workdir);

    // Begin writing the events stream — the Nim multi-stream writer
    // derives the `.ct` container path from the events path and emits
    // metadata + paths streams into the container on close.
    writer.begin_writing_trace_events(&trace_dir.join("trace.ct"))?;

    // P2.6: opt the canonical CTFS writer into column-aware step
    // encoding *before* the first `register_step` / `start` call.
    // `enable_column_aware_steps` is sticky for the lifetime of the
    // trace and gates the writer's `DeltaColumn` (tag 0x07) emission
    // path.  On legacy CBOR backends this is a trait-default no-op
    // (see `codetracer_trace_writer_nim/src/lib.rs:1135-1137`), but
    // the JS recorder is pinned to the Nim multi-stream writer so
    // the call lands on the real implementation.
    if state.column_aware {
        writer.enable_column_aware_steps();
        // Advertise that this trace's columns are sharp enough for
        // both per-column breakpoints and per-column motions — V8's
        // source-position table gives per-statement columns and the
        // instrumenter emits distinct columns for multi-statement-
        // per-line code, so both capabilities hold.  Sets meta.dat
        // bits 6 and 7 (FLAG_SUPPORTS_COLUMN_BREAKPOINTS,
        // FLAG_SUPPORTS_COLUMN_MOTIONS); see
        // `codetracer-trace-format-spec/internal-files.md`
        // §"Column-Aware Capability Flags".
        writer.enable_column_breakpoints_support();
        writer.enable_column_motions_support();
    }

    // We need to track whether we've called `start()` yet — the Nim writer
    // requires a `start()` call before registering steps/calls.
    let mut started = false;

    // P2.2: column-aware step emission.  Every `TraceEvent::Step`
    // produces one `register_step(path, line)` call on the Nim writer,
    // which always sets the writer-side column cursor to column 1 of
    // the named line (see
    // `codetracer-trace-format-nim/src/codetracer_trace_writer/multi_stream_writer.nim:494`).
    // A subsequent `write_delta_column(new_col - 1)` then lands the
    // cursor at the desired 1-based column.  The recorder doesn't need
    // to track a previous-step cursor because the reset is
    // unconditional.

    // P2.5: track paths we've registered with their line-length
    // tables so we emit the `paths.dat` Layout A record exactly once
    // per path (the first registration wins per the Nim writer's
    // semantics).
    let mut paths_with_line_lengths: std::collections::HashSet<PathBuf> =
        std::collections::HashSet::new();

    for event in &state.events {
        match event {
            TraceEvent::Path(p) => {
                // P2.5: when column-aware mode is on and the manifest
                // ships a line-length table for this path, register
                // it via the Layout A entry point.  Otherwise the
                // legacy `register_path` call is preserved (the Nim
                // writer takes the bare-path branch).
                if state.column_aware {
                    let path_str = p.to_string_lossy();
                    let line_lengths_opt = state.manifest.line_lengths.get(path_str.as_ref());
                    let line_lengths_slice: &[u32] =
                        line_lengths_opt.map(Vec::as_slice).unwrap_or(&[]);
                    if let Err(err) = writer.register_path_with_line_lengths(p, line_lengths_slice)
                    {
                        // Soft failure: the trace is still usable
                        // without per-line column counts (column
                        // resolution falls back to None at read time).
                        eprintln!(
                            "[codetracer-js-recorder] register_path_with_line_lengths failed for {}: {} \
                             (column resolution will fall back to None for this file)",
                            p.display(),
                            err,
                        );
                    }
                    paths_with_line_lengths.insert(p.clone());
                } else {
                    writer.register_path(p);
                }
            }
            TraceEvent::Type(tr) => {
                let upstream_kind = local_type_kind_to_upstream(tr.kind);
                writer.register_type(upstream_kind, &tr.lang_type);
            }
            TraceEvent::VariableName(name) => {
                writer.register_variable_name(name);
            }
            TraceEvent::Function(fr) => {
                // Look up the path from the manifest by path_id index.
                let path = state
                    .manifest
                    .paths
                    .get(fr.path_id)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("<unknown>"));
                writer.register_function(&fr.name, &path, codetracer_trace_types::Line(fr.line));
            }
            TraceEvent::Step(sr) => {
                let path = state
                    .manifest
                    .paths
                    .get(sr.path_id)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("<unknown>"));

                // The Nim writer requires a start() call before the first step.
                if !started {
                    writer.start(&path, codetracer_trace_types::Line(sr.line));
                    started = true;
                }

                // P2.5: lazy register-with-line-lengths.  Path events
                // for files reached only through the source-map
                // resolver may not have a corresponding TraceEvent::Path
                // entry up front; when we see the first step for a
                // file we haven't registered yet, fall through to the
                // Layout A entry point now (when column-aware).
                if state.column_aware && !paths_with_line_lengths.contains(&path) {
                    let path_str = path.to_string_lossy();
                    let line_lengths_opt = state.manifest.line_lengths.get(path_str.as_ref());
                    let line_lengths_slice: &[u32] =
                        line_lengths_opt.map(Vec::as_slice).unwrap_or(&[]);
                    if let Err(err) =
                        writer.register_path_with_line_lengths(&path, line_lengths_slice)
                    {
                        eprintln!(
                            "[codetracer-js-recorder] register_path_with_line_lengths failed for {}: {} \
                             (column resolution will fall back to None for this file)",
                            path.display(),
                            err,
                        );
                    }
                    paths_with_line_lengths.insert(path.clone());
                }

                // P2.2: column-aware step emission.  Mirrors the
                // Python recorder's cursor pattern (see
                // `codetracer-python-recorder/src/runtime/tracer/events.rs:443-488`):
                //
                //   * Same-line move with a known previous column:
                //     emit one `DeltaColumn(new - prev)` event (a
                //     no-op when delta is 0; the cursor still updates).
                //
                //   * Line change OR first step: emit a fresh
                //     `register_step(path, line)` — the writer resets
                //     its column cursor to 1 per the CTFS spec — then
                //     a `DeltaColumn(new - 1)` when `new > 1` to land
                //     at the desired column.
                //
                //   * `column_aware` disabled OR no column info on the
                //     site: fall back to plain `register_step` (no
                //     `DeltaColumn` events).
                //
                // The manifest's `col` is the SWC byte offset on the
                // line (0-based).  The CTFS spec uses 1-based column
                // numbering, so the on-wire target column is
                // `manifest_col + 1`.
                let new_line = sr.line;
                let new_column_1based: Option<i64> = sr.column.map(|c| c + 1);

                // Every `TraceEvent::Step` is a logical step in the
                // user's mental model — record one `register_step` per
                // invocation so the user-facing step count matches the
                // number of times the runtime emitted a step (the
                // pre-column-aware semantic).  Column nudges layer on
                // top as optional refinements.
                writer.register_step(&path, codetracer_trace_types::Line(new_line));

                if let (true, Some(new_col)) = (state.column_aware, new_column_1based) {
                    // The Nim multi-stream writer's `registerStep`
                    // unconditionally sets `lastGlobalLineIndex = gli`,
                    // where `gli` is "column 1 of the target line" (see
                    // `codetracer-trace-format-nim/src/codetracer_trace_writer/multi_stream_writer.nim:467,494`).
                    // The reset happens on EVERY `register_step` call,
                    // not only on line transitions — the writer treats
                    // every absolute / delta step as "the cursor now
                    // sits at column 1 of the named line".
                    //
                    // Therefore the DeltaColumn delta the JS recorder
                    // must emit to land at `new_col` is always
                    // `new_col - 1`, regardless of whether the previous
                    // step was on the same line.  Modelling the cursor
                    // as sticky across same-line repeats (the pre-fix
                    // behaviour) caused the third (and subsequent)
                    // statements on a multi-statement line to collapse
                    // onto the *previous* statement's column because
                    // the delta was computed against the wrong base.
                    let delta = new_col - 1;
                    if delta != 0 {
                        writer.write_delta_column(delta);
                    }
                }
            }
            TraceEvent::Call(cr) => {
                // Look up function info from the manifest to ensure the function
                // is registered in the Nim writer.
                let func = state.manifest.functions.get(cr.function_id);
                let (func_path, func_line, func_name) = match func {
                    Some(f) => {
                        let p = state
                            .manifest
                            .paths
                            .get(f.path_index)
                            .map(PathBuf::from)
                            .unwrap_or_else(|| PathBuf::from("<unknown>"));
                        (p, f.line as i64, f.name.as_str())
                    }
                    None => (PathBuf::from("<unknown>"), 0, "<unknown>"),
                };

                if !started {
                    writer.start(&func_path, codetracer_trace_types::Line(func_line));
                    started = true;
                }

                let fid = writer.ensure_function_id(
                    func_name,
                    &func_path,
                    codetracer_trace_types::Line(func_line),
                );

                // Stage each call argument via `writer.arg(name, value)` BEFORE
                // calling `register_call`.  The Nim multi-stream writer pairs
                // each `register_call_arg` (which `arg` invokes internally)
                // with the *next* `register_call` — the staged args are
                // consumed and cleared from the writer's pending-args buffer.
                //
                // Passing `args` as the second positional argument to
                // `register_call` is a no-op on the Nim backend (the parameter
                // is named `_args`); the Ruby recorder hit exactly this gap
                // (handoff entry 1.22).  We resolve the variable_id back into
                // its registered name so `arg()` can stage a (name, CBOR) pair.
                for a in &cr.args {
                    let var_name = state
                        .var_name_registry
                        .map
                        .iter()
                        .find(|(_, &id)| id == a.variable_id)
                        .map(|(name, _)| name.clone())
                        .unwrap_or_else(|| format!("_param{}", a.variable_id));
                    let v = local_value_to_upstream(&a.value, &mut writer);
                    // `arg` registers the variable on the current step AND
                    // stages it for the upcoming call record's args field.
                    writer.arg(&var_name, v);
                }

                // The second parameter is intentionally empty: the Nim writer
                // consumes the pending-args buffer staged via `arg()` above.
                writer.register_call(fid, Vec::new());
            }
            TraceEvent::Return(rr) => {
                let v = local_value_to_upstream(&rr.return_value, &mut writer);
                writer.register_return(v);
            }
            TraceEvent::Value(fvr) => {
                // Look up variable name — we need the name string, not just the ID.
                // The var_name_registry maps name->id; we need the reverse lookup.
                // Since we don't have the reverse map readily available during
                // replay, we store the variable name as "var_{id}". A more precise
                // approach would be to store a reverse map, but the Nim writer
                // handles variable IDs internally.
                let var_name = state
                    .var_name_registry
                    .map
                    .iter()
                    .find(|(_, &id)| id == fvr.variable_id)
                    .map(|(name, _)| name.clone())
                    .unwrap_or_else(|| format!("var_{}", fvr.variable_id));
                let v = local_value_to_upstream(&fvr.value, &mut writer);
                writer.register_variable_with_full_value(&var_name, v);
            }
            TraceEvent::Assignment(ar) => {
                writer.add_event(codetracer_trace_types::TraceLowLevelEvent::Assignment(
                    ar.clone(),
                ));
            }
            TraceEvent::Event(re) => {
                // Map local EventLogKind to upstream.  We produce Write
                // (stdout) and WriteOther (stderr) — see append_events
                // case 3 above for the JS console-method classification.
                let upstream_kind = match re.kind {
                    EventLogKind::Write => codetracer_trace_types::EventLogKind::Write,
                    EventLogKind::WriteOther => codetracer_trace_types::EventLogKind::WriteOther,
                };
                writer.register_special_event(upstream_kind, &re.metadata, &re.content);
            }
            // Thread-lifecycle events route through the dedicated FFI entry
            // points added in handoff entry 1.30 (codetracer-trace-format-nim
            // commit bc560ea + codetracer-trace-format commit fa444d8).  The
            // JS recorder uses async-context tracking (executionAsyncId) to
            // synthesize per-async-context thread IDs (see
            // packages/runtime/src/async-context.ts).
            TraceEvent::ThreadStart(tid) => {
                writer.register_thread_start(*tid);
            }
            TraceEvent::ThreadSwitch(tid) => {
                writer.register_thread_switch(*tid);
            }
            TraceEvent::ThreadExit(tid) => {
                writer.register_thread_exit(*tid);
            }
        }
    }

    // ── Alternate source views (Deminification Support) ──────────────
    //
    // Migrate the P6.2 autoformat sidecar (`<trace>/files/<name>.fmt.js`
    // + `.fmt.js.map`) into the canonical CTFS `srcviews.dat` /
    // `srcviews.off` stream.  See
    // `codetracer-trace-format-spec/internal-files.md` §"Alternate
    // Source Views (Deminification Support)" for the wire format and
    // discovery contract — replay-server walks `srcviews.dat` at
    // trace-open time (commit `483c9f7e`).
    //
    // The recorder-side autoformat pass (see
    // `packages/cli/src/record-cmd.ts`) stages two `extra_files`
    // entries per formatted source:
    //
    //   * key = `<abs>/lib.min.js.fmt.js`        → formatted bytes
    //   * key = `<abs>/lib.min.js.fmt.js.map`    → V3 sourcemap (JSON)
    //
    // The `<abs>/lib.min.js.fmt.js` virtual path is ALSO present in
    // `manifest.paths` (the instrumenter routed the SWC pass through
    // the formatted view), so its index there is the writer's
    // `path_id` for the registration.
    //
    // `view_kind = 1` is `prettier_format` per the spec enum.  The
    // `view_name` is the basename of the virtual path (e.g.
    // `"lib.min.js.fmt.js"`) — the user-facing label surfaced in the
    // DAP `stackTrace` response by the replay-server.
    //
    // We track which `extra_files` keys we successfully consumed so
    // the caller (flush_and_stop) can skip the corresponding
    // `<trace>/files/` sidecar write — the canonical srcviews record
    // is authoritative once present.  Entries that fail to migrate
    // (e.g. virtual path missing from `manifest.paths`, sourcemap
    // missing) fall through to the legacy sidecar path so the trace
    // still carries the formatted view in some form.
    let mut consumed_extra_files: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for (virtual_path, content) in &state.manifest.extra_files {
        // Only migrate the formatted-source entries; `.fmt.js.map`
        // entries are picked up implicitly as the sibling sourcemap.
        if !virtual_path.ends_with(".fmt.js") {
            continue;
        }
        let map_key = format!("{}.map", virtual_path);
        let Some(path_id) = state.manifest.paths.iter().position(|p| p == virtual_path) else {
            // Virtual path didn't make it into manifest.paths — leave
            // the sidecar fallback in place so the formatted view is
            // still discoverable by older replay-servers.
            continue;
        };
        let sourcemap_bytes: &[u8] = state
            .manifest
            .extra_files
            .get(&map_key)
            .map(|s| s.as_bytes())
            .unwrap_or(&[]);
        let view_name = Path::new(virtual_path)
            .file_name()
            .map(|os| os.to_string_lossy().into_owned())
            .unwrap_or_else(|| virtual_path.clone());
        match writer.register_source_view(
            codetracer_trace_types::PathId(path_id),
            1, // prettier_format per the spec enum
            &view_name,
            content.as_bytes(),
            sourcemap_bytes,
        ) {
            Ok(_idx) => {
                consumed_extra_files.insert(virtual_path.clone());
                if !sourcemap_bytes.is_empty() {
                    consumed_extra_files.insert(map_key);
                }
            }
            Err(err) => {
                // Soft failure: log and fall through to the sidecar
                // path.  The trace stays usable — the formatted view
                // just won't appear in the canonical srcviews stream
                // for this file.
                eprintln!(
                    "[codetracer-js-recorder] register_source_view failed for {}: {} \
                     (falling back to <trace>/files/ sidecar)",
                    virtual_path, err,
                );
            }
        }
    }

    // Finish writing streams and close the writer to produce the final output.
    writer.finish_writing_trace_events()?;

    // Write binary meta.dat
    writer.write_meta_dat("codetracer-js-recorder")?;

    writer.close()?;

    Ok(consumed_extra_files)
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

    // Write the canonical CTFS multi-stream `.ct` container via the
    // Nim-backed writer.  This is the only on-disk shape produced by the
    // recorder per Recorder-CLI-Conventions.md §4 — the legacy
    // `trace.json` events sidecar (kept during the binary-output
    // transition) was removed on 2026-05-08 along with the `--format` /
    // `CODETRACER_FORMAT` surface area.  Use `ct print` from
    // `codetracer-trace-format-nim` to convert the produced `.ct` bundle
    // to JSON / text.
    let consumed_extra_files =
        write_binary_trace(&state, &state.trace_dir.clone()).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to write CTFS trace: {e}"),
            )
        })?;

    if std::env::var("CODETRACER_MANAGED_UPLOAD_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .is_some()
    {
        codetracer_ctfs::trace_storage::upload_materialized_artifacts_from_env(
            &state.trace_dir,
            "javascript",
        )
        .map_err(|error| {
            Error::new(
                Status::GenericFailure,
                format!("Failed to upload materialized trace: {}", error.message),
            )
        })?;
    }

    // trace_metadata.json and trace_paths.json sidecars retired with the
    // v3 CTFS rollout — that information now lives in `meta.dat` inside
    // the `.ct` container produced by `write_binary_trace` above.

    // Copy source files to files/ directory
    let files_dir = state.trace_dir.join("files");
    fs::create_dir_all(&files_dir).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("Failed to create files directory: {e}"),
        )
    })?;

    for source_path in &state.manifest.paths {
        let dest = files_dir.join(relativise_for_files_dir(source_path));
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

    // P6.2 → canonical CTFS migration: materialise extra files
    // (autoformat formatted source + its V3 sourcemap sibling) into
    // the trace's files/ directory ONLY for entries that did NOT
    // migrate into the canonical `srcviews.dat` stream.
    //
    // The autoformat pair (`<name>.fmt.js` + `<name>.fmt.js.map`) is
    // now served from `srcviews.dat` by the replay-server (commit
    // `483c9f7e`); writing it again under `<trace>/files/` would
    // duplicate the formatted view bytes on disk and confuse newer
    // readers that already discover it through CTFS.  Entries that
    // failed the canonical registration (logged above) fall through
    // here so the trace still carries the view in the legacy P6.2
    // location.
    //
    // We deliberately allow `extra_files` to overwrite a `paths`
    // entry: when the autoformat pass replaced the original source
    // with the formatted view, both keys point at the same virtual
    // path and the manifest's `extra_files` value is authoritative.
    for (virtual_path, content) in &state.manifest.extra_files {
        if consumed_extra_files.contains(virtual_path) {
            continue;
        }
        let dest = files_dir.join(relativise_for_files_dir(virtual_path));
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&dest, content);
    }

    Ok(state.trace_dir.to_string_lossy().to_string())
}

/// Project an absolute source-side path onto a path safe to join under
/// `<trace>/files/`.
///
/// Strips leading '/' from POSIX absolute paths and the leading
/// `X:[\\/]` drive prefix from Windows absolute paths so that
/// `files_dir.join(relative)` lands at the correct sub-tree rather
/// than replacing `files_dir` outright.
///
/// Dropping only the drive letter (e.g. `"D:\path"` → `":\path"`)
/// would leave an invalid Windows path component, which makes the
/// subsequent write silently fail — drop the whole 2-char `X:`
/// prefix instead.
fn relativise_for_files_dir(absolute: &str) -> &str {
    let trimmed = absolute.strip_prefix('/').unwrap_or(absolute);
    trimmed
        .get(2..)
        .filter(|_| trimmed.as_bytes().get(1) == Some(&b':'))
        .map(|s| {
            s.strip_prefix('\\')
                .or_else(|| s.strip_prefix('/'))
                .unwrap_or(s)
        })
        .unwrap_or(trimmed)
}
