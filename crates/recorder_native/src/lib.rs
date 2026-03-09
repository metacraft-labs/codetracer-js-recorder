#[macro_use]
extern crate napi_derive;

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
