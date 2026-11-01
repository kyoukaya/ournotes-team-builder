//! Golden-output harness: `golden <input.json> <output.json> [rounds]`.
//! Runs create + run, strips timing/stat fields, writes normalized JSON.
use haneoka_team_engine::session;
use serde_json::{json, Value};
use std::time::Instant;
fn strip(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("elapsedMs");
            m.remove("stats");
            m.values_mut().for_each(strip);
        }
        Value::Array(a) => a.iter_mut().for_each(strip),
        _ => {}
    }
}
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let input: Value = serde_json::from_str(&std::fs::read_to_string(&a[1]).unwrap()).unwrap();
    let rounds: usize = a.get(3).map_or(1, |s| s.parse().unwrap());
    let created = session::execute(&json!({"op":"create","data":input["data"]})).unwrap();
    let handle = created["handle"].clone();
    let mut out = Value::Null;
    for _ in 0..rounds {
        let t = Instant::now();
        out = session::execute(&json!({"op":"run","handle":handle,"request":input["request"],"charts":input["charts"]})).unwrap();
        eprintln!("run {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);
    }
    strip(&mut out);
    std::fs::write(&a[2], serde_json::to_string_pretty(&out).unwrap()).unwrap();
}
