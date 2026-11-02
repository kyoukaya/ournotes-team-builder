// WebAssembly golden harness: `node examples/wasm_golden.mjs <engine.wasm> <input.json> <output.json> [rounds]`.
// Mirrors examples/golden.rs (session create + run, `elapsedMs`/`stats` stripped)
// through the exported C ABI, so its output can be diffed against the native one.
import { readFileSync, writeFileSync } from "node:fs";

const [wasmPath, inputPath, outputPath, roundsArg] = process.argv.slice(2);
const rounds = Number(roundsArg ?? 1);
const module = await WebAssembly.compile(readFileSync(wasmPath));
const env = {
  haneoka_now_ms: () => performance.timeOrigin + performance.now(),
  haneoka_progress: () => {},
  haneoka_search_floor: () => {},
};
const imports = {};
for (const { module: name, name: field, kind } of WebAssembly.Module.imports(module)) {
  if (kind !== "function") continue;
  imports[name] ??= {};
  imports[name][field] = env[field] ?? (() => { throw new Error(`unexpected import ${name}.${field}`); });
}
const { exports } = await WebAssembly.instantiate(module, imports);

function call(request) {
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const pointer = exports.haneoka_buffer_alloc(bytes.length + 1);
  new Uint8Array(exports.memory.buffer, pointer, bytes.length + 1).set([...bytes, 0]);
  const result = exports.haneoka_context_json(pointer);
  exports.haneoka_buffer_free(pointer, bytes.length + 1);
  const memory = new Uint8Array(exports.memory.buffer);
  let end = result;
  while (memory[end] !== 0) end++;
  const text = new TextDecoder().decode(memory.subarray(result, end));
  exports.haneoka_string_free(result);
  const value = JSON.parse(text);
  if (value?.error !== undefined && Object.keys(value).length === 1) throw new Error(value.error);
  return value;
}

function strip(value) {
  if (Array.isArray(value)) value.forEach(strip);
  else if (value && typeof value === "object") {
    delete value.elapsedMs;
    delete value.stats;
    Object.values(value).forEach(strip);
  }
}

const input = JSON.parse(readFileSync(inputPath, "utf8"));
const { handle } = call({ op: "create", data: input.data });
let out = null;
for (let round = 0; round < rounds; round++) {
  const started = performance.now();
  out = call({ op: "run", handle, request: input.request, charts: input.charts });
  console.error(`run ${(performance.now() - started).toFixed(0)} ms`);
}
strip(out);
writeFileSync(outputPath, JSON.stringify(out, null, 2));
