//! Web-request span bookkeeping for the JavaScript recorder (RS-M9).
//!
//! # Why this module exists
//!
//! The JS recorder does not drive the trace writer live.  `append_events`
//! accumulates a `Vec<TraceEvent>` in memory and `flush_and_stop` replays the
//! whole vector into a freshly created [`NimTraceWriter`] (see
//! `write_binary_trace` in `lib.rs`).  A span therefore cannot ask the writer
//! "what step am I at?" when the request starts — the writer does not exist
//! yet.
//!
//! What a span records at request time is instead a **mark**: the length of
//! the buffered event vector at that instant.  During the replay the marks are
//! translated into real step ids by reading
//! [`NimTraceWriter::next_step_index`] at the moment the replay reaches the
//! marked position.  That is the writer's own exec-event counter — the counter
//! readers walk (`ct_reader_step(n)`, a span's `start_step` / `end_step`, the
//! Request Panel's `startGeid`) — and it advances for absolute steps, column
//! deltas, call/return records, special events and thread lifecycle events
//! alike.  A recorder counting its own `register_step` calls would drift from
//! it the first time it emitted a `DeltaColumn` or a `ThreadSwitch`, and the
//! JS recorder emits both constantly.
//!
//! # The structural bits are measured, never declared
//!
//! `codetracer-specs/Planned-Features/Trace-Spans.md` §2.4 is explicit that
//! `contiguous_on_one_thread` is a property of the recorder's stream layout,
//! not of the language, and that a recorder must compute it rather than copy a
//! row from the worked-examples table.  For this recorder:
//!
//! * **`shares_timeline` is always true.**  A Node process is one recording
//!   with one exec stream; every span is a slice of that one ordering.
//! * **`contiguous_on_one_thread` is computed** from the thread events that
//!   land inside the span's own mark range.  The JS runtime maps each Node
//!   async context (`async_hooks.executionAsyncId()`) onto a container thread
//!   id, so an `await` inside a handler, or a sibling request's events
//!   interleaving on the event loop, both show up as a `ThreadSwitch` to a
//!   different thread inside the range — and both genuinely break contiguity.
//!   A handler that runs to completion inside one async context with nothing
//!   else scheduled in between stays contiguous.
//! * **`concurrent_with_siblings` is computed** from the resolved step ranges:
//!   true when a span's `[start_step, end_step]` overlaps another span's.
//!
//! All three are derived here, from the recorder's own bookkeeping, so a
//! middleware cannot misreport them.

use codetracer_trace_writer_nim::{
    SpanRecord, SPAN_STATUS_ERROR, SPAN_STATUS_OK, SPAN_STATUS_UNKNOWN,
};
use std::collections::HashMap;

/// Wire values of a span's `status` field, mirrored from the trace format so
/// the N-API surface can take a plain integer.
pub(crate) fn status_from_u32(raw: u32) -> u8 {
    match raw {
        1 => SPAN_STATUS_OK,
        2 => SPAN_STATUS_ERROR,
        _ => SPAN_STATUS_UNKNOWN,
    }
}

/// One span in flight or settled, bound to positions in the buffered event
/// vector rather than to step ids (see the module docs for why).
#[derive(Debug, Clone)]
pub(crate) struct PendingSpan {
    /// 1-based, monotonic within the container.  The last-record-wins key.
    pub span_id: u64,
    /// `"web-request"` for the Express middleware; the field exists so the
    /// same plumbing can carry `"test"` or `"transaction"` spans later.
    pub span_type: String,
    /// e.g. `"GET /api/users"`.
    pub label: String,
    /// UNIX epoch nanoseconds, taken on the Rust side so a JS caller cannot
    /// hand us a millisecond-resolution `Date.now()` and call it nanoseconds.
    pub start_wall_ns: u64,
    /// Zero until the span settles.
    pub end_wall_ns: u64,
    /// `SPAN_STATUS_UNKNOWN` until the span settles.
    pub status: u8,
    /// Metadata contributed when the request entered the pipeline.
    pub open_metadata: Vec<(String, String)>,
    /// Metadata contributed when the response completed.  Merged over
    /// `open_metadata` at registration time, preserving emission order.
    pub close_metadata: Vec<(String, String)>,
    /// Length of the buffered event vector when the span opened: the index of
    /// the first event that belongs to this span.
    pub start_event_index: usize,
    /// Length of the buffered event vector when the span settled, i.e. one
    /// past the last event that belongs to it.  `None` while open.
    pub end_event_index: Option<usize>,
}

impl PendingSpan {
    /// The span's metadata as the settled record should carry it: the
    /// open-time pairs in emission order, then the close-time pairs, with a
    /// close-time value replacing an open-time one **in place** when the keys
    /// collide.  Metadata order is part of the wire contract
    /// (`CTFS-Request-Span-Streams.md` §"Record Model"), so this must be
    /// deterministic and must not go through a hash map.
    pub fn merged_metadata(&self) -> Vec<(String, String)> {
        let mut merged = self.open_metadata.clone();
        for (key, value) in &self.close_metadata {
            match merged.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value.clone(),
                None => merged.push((key.clone(), value.clone())),
            }
        }
        merged
    }
}

/// What the replay pass measured for one span.
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedSpan {
    /// The exec-stream index the first event inside the span occupies.
    pub start_step: u64,
    /// The exec-stream index of the last event inside the span; clamped to
    /// `start_step` when the span contained no exec events at all.
    pub end_step: u64,
    /// The container thread (Node async context) that was current when the
    /// span opened.
    pub thread_id: u64,
    /// A thread event for a DIFFERENT thread landed inside the span's range —
    /// an `await` in the handler, or a sibling request interleaving on the
    /// event loop.
    pub crossed_thread: bool,
    /// The span's step range overlaps another span's.
    pub concurrent: bool,
    /// The start mark was reached during the replay.  A span whose mark was
    /// never reached (which would mean the mark table and the event vector
    /// disagree) is dropped rather than written with a fabricated range.
    pub start_resolved: bool,
    /// The end mark was reached during the replay.
    pub end_resolved: bool,
}

/// Resolves span marks into step ranges while `write_binary_trace` replays the
/// buffered events into the writer.
///
/// The caller drives it: [`Self::at_event_index`] immediately before it hands
/// event `idx` to the writer, and [`Self::observe_thread`] immediately after
/// it registers a thread-lifecycle event.
pub(crate) struct SpanResolver<'a> {
    spans: &'a [PendingSpan],
    starts_at: HashMap<usize, Vec<usize>>,
    ends_at: HashMap<usize, Vec<usize>>,
    resolved: Vec<ResolvedSpan>,
    open_slots: Vec<usize>,
    current_thread: u64,
}

impl<'a> SpanResolver<'a> {
    pub fn new(spans: &'a [PendingSpan]) -> Self {
        let mut starts_at: HashMap<usize, Vec<usize>> = HashMap::new();
        let mut ends_at: HashMap<usize, Vec<usize>> = HashMap::new();
        for (slot, span) in spans.iter().enumerate() {
            starts_at
                .entry(span.start_event_index)
                .or_default()
                .push(slot);
            if let Some(end) = span.end_event_index {
                ends_at.entry(end).or_default().push(slot);
            }
        }
        Self {
            spans,
            starts_at,
            ends_at,
            resolved: vec![ResolvedSpan::default(); spans.len()],
            open_slots: Vec::new(),
            current_thread: 0,
        }
    }

    /// Whether there is any span work at all — lets the caller skip the
    /// per-event hook entirely for the overwhelmingly common non-web
    /// recording.
    pub fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    /// Called with the writer's current `next_step_index()` just before event
    /// `idx` is registered (and once more with `idx == events.len()` after the
    /// last event, so a span that settled after the final event still lands).
    ///
    /// Start marks are processed before end marks at the same index.  That
    /// ordering is what makes the degenerate case correct: a request that
    /// recorded no events at all opens and settles at the SAME index, and
    /// resolving its end before its start would clamp the range against a
    /// start of zero and produce `end < start`.  For two DIFFERENT spans
    /// meeting at one index the order is inert — a span's end does not consult
    /// the open set, and the thread events at index `idx` are registered after
    /// this call, so they belong to the span that just opened.
    pub fn at_event_index(&mut self, idx: usize, next_step_index: u64) {
        if let Some(slots) = self.starts_at.get(&idx) {
            for &slot in slots {
                self.resolved[slot].start_step = next_step_index;
                self.resolved[slot].thread_id = self.current_thread;
                self.resolved[slot].start_resolved = true;
                self.open_slots.push(slot);
            }
        }
        if let Some(slots) = self.ends_at.get(&idx) {
            for &slot in slots {
                let start_step = self.resolved[slot].start_step;
                // `next_step_index` is where the NEXT exec event will go, so
                // the last event inside the span is one before it.  A span
                // that recorded nothing at all collapses to a single step id
                // rather than an inverted range.
                self.resolved[slot].end_step = next_step_index.saturating_sub(1).max(start_step);
                self.resolved[slot].end_resolved = true;
                self.open_slots.retain(|&s| s != slot);
            }
        }
    }

    /// Called after a `ThreadStart` / `ThreadSwitch` event is registered.
    ///
    /// The JS runner emits `ThreadStart(x)` immediately followed by
    /// `ThreadSwitch(x)` for a context it has not seen before, and a bare
    /// `ThreadSwitch(x)` when returning to a known one, so treating both as
    /// "the active thread is now x" is exact.
    pub fn observe_thread(&mut self, thread_id: u64) {
        self.current_thread = thread_id;
        for &slot in &self.open_slots {
            if self.resolved[slot].thread_id != thread_id {
                self.resolved[slot].crossed_thread = true;
            }
        }
    }

    /// Finish the pass: compute `concurrent_with_siblings` from the resolved
    /// step ranges and hand back the measurements.
    pub fn finish(mut self) -> Vec<ResolvedSpan> {
        let count = self.resolved.len();
        for i in 0..count {
            if !self.resolved[i].start_resolved || !self.resolved[i].end_resolved {
                continue;
            }
            for j in 0..count {
                if i == j || !self.resolved[j].start_resolved || !self.resolved[j].end_resolved {
                    continue;
                }
                let a = &self.resolved[i];
                let b = &self.resolved[j];
                if a.start_step <= b.end_step && b.start_step <= a.end_step {
                    self.resolved[i].concurrent = true;
                    break;
                }
            }
        }
        self.resolved
    }
}

/// One record to append to `spans.dat`, tagged with the event-vector position
/// it was published at so the stream keeps its true chronological order.
pub(crate) struct OrderedSpanRecord {
    pub at_event_index: usize,
    pub record: SpanRecord,
}

/// Build the `spans.dat` records for a finished recording.
///
/// Every span produces **two** records with the same `span_id`: an `is_open`
/// record published where the request entered the pipeline, and the settled
/// record published where the response completed.  That is the contract
/// readers resolve by last-record-wins, and it is what makes an in-flight row
/// visible to a live consumer.  A span whose start mark was never reached is
/// dropped; a span that never settled contributes only its open record.
///
/// The returned records are sorted by publication position, so the stream a
/// batch writer produces is byte-order-equivalent to what a live writer would
/// have appended.
pub(crate) fn build_span_records(
    spans: &[PendingSpan],
    resolved: &[ResolvedSpan],
) -> Vec<SpanRecord> {
    let mut ordered: Vec<OrderedSpanRecord> = Vec::with_capacity(spans.len() * 2);

    for (slot, span) in spans.iter().enumerate() {
        let measured = &resolved[slot];
        if !measured.start_resolved {
            continue;
        }

        ordered.push(OrderedSpanRecord {
            at_event_index: span.start_event_index,
            record: SpanRecord {
                span_id: span.span_id,
                parent_span_id: 0,
                is_open: true,
                is_external: false,
                status: SPAN_STATUS_UNKNOWN,
                start_wall_ns: span.start_wall_ns,
                end_wall_ns: 0,
                // One Node process per recording: the container's primary and
                // only process.
                process_ord: 0,
                thread_id: measured.thread_id,
                start_step: measured.start_step,
                end_step: 0,
                external_recording: String::new(),
                external_path: String::new(),
                span_type: span.span_type.clone(),
                label: span.label.clone(),
                // While the span is open nothing about its extent is known
                // yet, so the structural bits carry only what is true by
                // construction: it shares the recording's one timeline.
                contiguous_on_one_thread: false,
                shares_timeline: true,
                concurrent_with_siblings: false,
                metadata: span.open_metadata.clone(),
            },
        });

        if !measured.end_resolved {
            continue;
        }

        ordered.push(OrderedSpanRecord {
            at_event_index: span.end_event_index.unwrap_or(span.start_event_index),
            record: SpanRecord {
                span_id: span.span_id,
                parent_span_id: 0,
                is_open: false,
                is_external: false,
                status: span.status,
                start_wall_ns: span.start_wall_ns,
                end_wall_ns: span.end_wall_ns,
                process_ord: 0,
                thread_id: measured.thread_id,
                start_step: measured.start_step,
                end_step: measured.end_step,
                external_recording: String::new(),
                external_path: String::new(),
                span_type: span.span_type.clone(),
                label: span.label.clone(),
                contiguous_on_one_thread: !measured.crossed_thread,
                shares_timeline: true,
                concurrent_with_siblings: measured.concurrent,
                metadata: span.merged_metadata(),
            },
        });
    }

    ordered.sort_by_key(|entry| entry.at_event_index);
    ordered.into_iter().map(|entry| entry.record).collect()
}

/// Parse the `[[key, value], ...]` metadata array the JS side sends.
///
/// A JSON object would have been the obvious shape and is the wrong one:
/// metadata order is part of the wire contract and `serde_json::Map` does not
/// preserve it by default.  An unparseable payload yields no metadata rather
/// than an error — a middleware bug must not take down the recording.
pub(crate) fn parse_metadata(json: &str) -> Vec<(String, String)> {
    if json.is_empty() || json == "[]" {
        return Vec::new();
    }
    match serde_json::from_str::<Vec<(String, String)>>(json) {
        Ok(pairs) => pairs,
        Err(err) => {
            eprintln!("[codetracer-js-recorder] ignoring malformed span metadata: {err}");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(id: u64, start: usize, end: Option<usize>) -> PendingSpan {
        PendingSpan {
            span_id: id,
            span_type: "web-request".to_string(),
            label: format!("GET /{id}"),
            start_wall_ns: 1_000 * id,
            end_wall_ns: 2_000 * id,
            status: SPAN_STATUS_OK,
            open_metadata: vec![("http.method".to_string(), "GET".to_string())],
            close_metadata: vec![("http.status_code".to_string(), "200".to_string())],
            start_event_index: start,
            end_event_index: end,
        }
    }

    /// The resolver must read step ids off the writer's counter at the marked
    /// positions, not off a count of marks.
    #[test]
    fn marks_resolve_to_the_writers_step_index() {
        let spans = vec![span(1, 2, Some(5))];
        let mut resolver = SpanResolver::new(&spans);
        // Pretend the replay walked six events and the writer's counter ran
        // ahead of the event index (column deltas, thread events, …).
        let counters = [0u64, 3, 7, 9, 11, 14, 20];
        for (idx, &counter) in counters.iter().enumerate() {
            resolver.at_event_index(idx, counter);
        }
        let resolved = resolver.finish();
        assert_eq!(
            resolved[0].start_step, 7,
            "start = counter at the open mark"
        );
        assert_eq!(
            resolved[0].end_step, 13,
            "end = counter at the close mark - 1"
        );
    }

    /// A span that recorded nothing — a request whose whole handling happened
    /// in uninstrumented library code — must not produce an inverted range.
    #[test]
    fn empty_span_collapses_to_one_step() {
        let spans = vec![span(1, 1, Some(1))];
        let mut resolver = SpanResolver::new(&spans);
        resolver.at_event_index(0, 0);
        resolver.at_event_index(1, 4);
        let resolved = resolver.finish();
        assert_eq!(resolved[0].start_step, 4);
        assert_eq!(resolved[0].end_step, 4);
    }

    /// One span settling exactly where the next opens keeps both ranges
    /// intact and disjoint.
    #[test]
    fn spans_meeting_at_one_index_stay_disjoint() {
        let spans = vec![span(1, 0, Some(3)), span(2, 3, Some(6))];
        let mut resolver = SpanResolver::new(&spans);
        for idx in 0..=6 {
            resolver.at_event_index(idx, idx as u64 * 2);
        }
        let resolved = resolver.finish();
        assert_eq!((resolved[0].start_step, resolved[0].end_step), (0, 5));
        assert_eq!((resolved[1].start_step, resolved[1].end_step), (6, 11));
        assert!(!resolved[0].concurrent, "adjacent ranges do not overlap");
        assert!(!resolved[1].concurrent);
    }

    /// A thread switch inside the range breaks contiguity; one outside does
    /// not.  This is the bit the milestone turns on for Node.
    #[test]
    fn contiguity_follows_thread_events_inside_the_range() {
        let spans = vec![span(1, 1, Some(3)), span(2, 4, Some(6))];
        let mut resolver = SpanResolver::new(&spans);
        resolver.observe_thread(1); // before either span opens
        resolver.at_event_index(0, 0);
        resolver.at_event_index(1, 1);
        resolver.at_event_index(2, 2);
        resolver.observe_thread(9); // INSIDE span 1
        resolver.at_event_index(3, 3);
        resolver.observe_thread(9);
        resolver.at_event_index(4, 4); // span 2 opens on thread 9
        resolver.at_event_index(5, 5);
        resolver.at_event_index(6, 6);
        let resolved = resolver.finish();
        assert!(
            resolved[0].crossed_thread,
            "an await inside the span breaks contiguity"
        );
        assert!(
            !resolved[1].crossed_thread,
            "an uninterrupted handler stays contiguous"
        );
        assert_eq!(resolved[0].thread_id, 1);
        assert_eq!(resolved[1].thread_id, 9);
    }

    /// Overlapping step ranges are concurrent; disjoint ones are not.  The bit
    /// must be able to take both values in one recording.
    #[test]
    fn concurrency_is_measured_from_step_ranges() {
        let spans = vec![
            span(1, 0, Some(4)),
            span(2, 2, Some(3)),
            span(3, 5, Some(6)),
        ];
        let mut resolver = SpanResolver::new(&spans);
        for idx in 0..=6 {
            resolver.at_event_index(idx, idx as u64);
        }
        let resolved = resolver.finish();
        assert!(resolved[0].concurrent);
        assert!(resolved[1].concurrent);
        assert!(
            !resolved[2].concurrent,
            "a span after every sibling is not concurrent"
        );
    }

    /// Two records per span, in publication order, with the open record first.
    #[test]
    fn each_span_publishes_an_open_then_a_settled_record() {
        let spans = vec![span(1, 0, Some(9)), span(2, 3, Some(5))];
        let mut resolver = SpanResolver::new(&spans);
        for idx in 0..=9 {
            resolver.at_event_index(idx, idx as u64);
        }
        let records = build_span_records(&spans, &resolver.finish());
        let shape: Vec<(u64, bool)> = records.iter().map(|r| (r.span_id, r.is_open)).collect();
        assert_eq!(shape, vec![(1, true), (2, true), (2, false), (1, false)]);
        assert!(records.iter().all(|r| r.shares_timeline));
        assert!(records.iter().all(|r| !r.is_external));
    }

    /// A span that never settled still publishes its open record, so a
    /// recording killed mid-request shows the in-flight row.
    #[test]
    fn an_unsettled_span_publishes_only_its_open_record() {
        let spans = vec![span(1, 0, None)];
        let mut resolver = SpanResolver::new(&spans);
        for idx in 0..=3 {
            resolver.at_event_index(idx, idx as u64);
        }
        let records = build_span_records(&spans, &resolver.finish());
        assert_eq!(records.len(), 1);
        assert!(records[0].is_open);
    }

    #[test]
    fn close_metadata_overrides_in_place_and_appends_in_order() {
        let mut s = span(1, 0, Some(1));
        s.open_metadata = vec![
            ("http.method".to_string(), "GET".to_string()),
            ("http.route".to_string(), String::new()),
        ];
        s.close_metadata = vec![
            ("http.route".to_string(), "/api/users/:id".to_string()),
            ("http.status_code".to_string(), "200".to_string()),
        ];
        let merged = s.merged_metadata();
        assert_eq!(
            merged,
            vec![
                ("http.method".to_string(), "GET".to_string()),
                ("http.route".to_string(), "/api/users/:id".to_string()),
                ("http.status_code".to_string(), "200".to_string()),
            ]
        );
    }

    #[test]
    fn malformed_metadata_is_ignored_rather_than_fatal() {
        assert!(parse_metadata("not json").is_empty());
        assert!(parse_metadata("").is_empty());
        assert_eq!(
            parse_metadata(r#"[["a","b"]]"#),
            vec![("a".to_string(), "b".to_string())]
        );
    }
}
