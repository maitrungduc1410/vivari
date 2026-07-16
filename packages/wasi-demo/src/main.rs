// A tiny wasm32-wasip1 CLI exercising the WASI preview1 surface a real tool
// needs: argv, environ, a preopened directory, file read/write, and stdio. Rust
// std maps all of these onto WASI calls, which Vivari's runtime services
// against its VFS (#16 stage 1). Output is deterministic so tests can assert it.
//
// Usage: wasi_demo <input> <output>
//   - reads <input> (a file under a preopen), uppercases it,
//   - writes the result to <output>,
//   - prints "<WASI_GREETING>: <result>" to stdout and a byte count to stderr.

use std::env;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    let args: Vec<String> = env::args().collect();
    let input = args.get(1).cloned().unwrap_or_else(|| "/work/in.txt".to_string());
    let output = args.get(2).cloned().unwrap_or_else(|| "/work/out.txt".to_string());
    let greeting = env::var("WASI_GREETING").unwrap_or_else(|_| "hello".to_string());

    let content = fs::read_to_string(&input).expect("read input");
    let upper = content.to_uppercase();
    fs::write(&output, upper.as_bytes()).expect("write output");

    // Touch the clock so clock_time_get is exercised (kept out of asserted output
    // to stay deterministic).
    let _now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    println!("{}: {}", greeting, upper.trim_end());
    eprintln!("wasi-demo wrote {} bytes to {}", upper.len(), output);
}
