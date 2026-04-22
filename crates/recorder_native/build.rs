extern crate napi_build;

fn main() {
    napi_build::setup();

    // Link the Nim-backed trace writer static library.
    // The codetracer_trace_writer_nim crate declares its own build.rs that
    // handles this, but since we're pulling it in as a path dependency the
    // link directives need to be present in the final cdylib build as well.
    // The CODETRACER_NIM_LIB_DIR env var overrides the default sibling path.
    let nim_lib_dir = std::env::var("CODETRACER_NIM_LIB_DIR")
        .unwrap_or_else(|_| "../../../codetracer-trace-format-nim".to_string());
    println!("cargo:rustc-link-search=native={nim_lib_dir}");
    println!("cargo:rustc-link-lib=static=codetracer_trace_writer");

    // Link zstd (required by the Nim trace writer for compressed output).
    if let Ok(zstd_dir) = std::env::var("ZSTD_LIB_DIR") {
        println!("cargo:rustc-link-search=native={zstd_dir}");
    } else if let Ok(output) = std::process::Command::new("pkg-config")
        .args(["--libs-only-L", "libzstd"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for flag in stdout.split_whitespace() {
            if let Some(dir) = flag.strip_prefix("-L") {
                println!("cargo:rustc-link-search=native={dir}");
            }
        }
    }

    println!("cargo:rustc-link-lib=dylib=zstd");
    println!("cargo:rustc-link-lib=dylib=m");
}
