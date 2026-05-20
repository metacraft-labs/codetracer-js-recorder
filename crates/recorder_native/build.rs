extern crate napi_build;

fn main() {
    napi_build::setup();

    // The Nim-backed trace writer (`codetracer_trace_writer_nim`) and
    // libzstd (`zstd-sys`) emit their own `cargo:rustc-link-*` directives
    // from their build scripts, and Cargo propagates those to this cdylib
    // automatically — so they must NOT be duplicated here. The previous
    // hand-rolled copy hard-coded Unix-only assumptions (`-lm`, a sibling
    // `.a` path) and broke the Windows link (`LNK1181: cannot open m.lib`).
}
