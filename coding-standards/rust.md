# Rust

Read `core.md` first. This file says how its rules look in Rust.

Default stack: stable Rust on the newest edition the project allows, clippy with `pedantic`, `thiserror` in libraries, `anyhow` in binaries, serde, clap, and tokio for async. Use the repository's tools when they differ.

## What we're fighting

```rust
pub fn load_config(path: String, strict: bool) -> Result<HashMap<String, String>, String> {
    let contents = std::fs::read_to_string(path.clone()).unwrap();
    let mut map = HashMap::new();
    for line in contents.lines() {
        let parts: Vec<&str> = line.split('=').collect();
        if parts.len() == 2 {
            map.insert(parts[0].to_string().clone(), parts[1].to_string());
        } else if strict {
            return Err(format!("bad line: {}", line));
        }
    }
    Ok(map)
}
```

It panics on a missing file, takes ownership it doesn't need, clones twice to quiet the borrow checker, lets a flag decide whether bad input counts as an error, and returns a stringly typed map and a `String` error that no caller can match on. Parsed into a typed config instead:

```rust
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub max_lines: NonZeroUsize,
    pub exclude: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read {path}")]
    Read { path: PathBuf, source: io::Error },
    #[error("invalid config in {path}")]
    Parse { path: PathBuf, source: toml::de::Error },
}

pub fn load(path: &Path) -> Result<Config, ConfigError> {
    let contents = fs::read_to_string(path)
        .map_err(|source| ConfigError::Read { path: path.to_owned(), source })?;
    toml::from_str(&contents).map_err(|source| ConfigError::Parse { path: path.to_owned(), source })
}
```

## Types

- Wrap IDs and units in newtypes (`struct UserId(String)`) when mixing them up is a realistic mistake. Keep the field private and construct through `FromStr`, `TryFrom`, or a `new` that checks the invariant.
- Model states as an enum whose variants carry only their own data. No structs of `bool`s and `Option`s that must agree.
- Match exhaustively on enums you own. No `_ =>` arm, so a new variant breaks the build at every place that needs to handle it.
- No `bool` parameters that switch behavior, and no `Option<bool>`. Use an enum with named variants.
- Parse external data with serde into typed structs at the boundary. Use `deny_unknown_fields` for config, and `NonZero*`, newtypes, and enums for constrained values.
- Take borrowed parameters (`&str`, `&[T]`, `&Path`). Store owned data in struct fields. Return owned values.
- Don't `.clone()` to get past the borrow checker. Restructure ownership. Clone when you really need a second owner, and write `Arc::clone(&x)` so a cheap clone looks cheap.
- Start with concrete types. Use `impl Trait` in argument position for simple flexibility. Add a generic parameter or a trait only when two real implementations exist or an I/O boundary needs a test seam.
- `#![forbid(unsafe_code)]` unless the crate truly needs `unsafe`. Every `unsafe` block then gets a `// SAFETY:` comment.

## Errors

- Libraries return `thiserror` enums. Variants carry the context needed to act on them (paths, IDs) and keep the underlying error as `source`. No `String` errors and no `Box<dyn Error>` in library APIs.
- Keep error enums per module boundary. Don't funnel everything into one crate-wide enum with a `#[from]` for every dependency. Translate with `map_err` where the meaning changes.
- Binaries and CLIs use `anyhow`, adding `.context()` or `.with_context()` at each layer that knows something the error doesn't.
- Propagate with `?`.
- No `unwrap()` in non-test code. Prefer restructuring the types so the failure can't happen. When an invariant really guarantees success, use `expect` with a message that states the invariant.
- `panic!`, `unreachable!`, `todo!`, and `unimplemented!` don't belong in shipped paths except for true invariants.

## Control flow

- Use `let ... else` for early returns: `let Some(user) = users.get(id) else { return Err(...) };`.
- Use let chains (`if let Some(x) = a && x.ready()`) to flatten nested `if let` when the edition allows it.
- Use an iterator chain when it reads more clearly than the loop. Use a `for` loop when there are early exits, side effects, or state that a chain would hide.
- No index loops over collections (`for i in 0..v.len()`).
- Use `match` instead of `if`/`else if` chains over enum variants.

## Modules and crates

- Private by default, then `pub(crate)`, and `pub` only for the crate's real API.
- One concept per file. No `utils.rs` or `helpers.rs`.
- Split crates by responsibility when a workspace grows: pure logic with no I/O, filesystem or network access, and the CLI or server entrypoint.
- `pub use` re-exports only at the crate root, to shape the public API.

## Async

- Don't block inside async code. Use the async API or `tokio::task::spawn_blocking`.
- Never hold a `std::sync::Mutex` guard across an `.await`.
- Use `JoinSet` for concurrent tasks you own and await.

## Tests

- Unit tests in `#[cfg(test)] mod tests`, moved to a sibling `tests.rs` when the module gets long. Integration tests in `tests/` through the public API.
- `unwrap` and `expect` are fine in tests.
- No mocking frameworks. Use real temp directories and local servers. Add a trait seam only at an I/O boundary that can't run in tests.
- Use proptest for parsers and round-trips.

## Enforcement later

`loq`'s `[workspace.lints]` is the starting kit: `pedantic` plus `print_stdout`, `print_stderr`, `dbg_macro`, `exit`, `get_unwrap`, and `redundant_clone`, with `allow-unwrap-in-tests` in `clippy.toml`. Candidates to add:

| Rule | Lint |
| --- | --- |
| No `unwrap`, `expect` only with a reason | `clippy::unwrap_used`, `clippy::expect_used` (plus `allow-expect-in-tests`) |
| No panics in shipped paths | `clippy::panic`, `clippy::todo`, `clippy::unimplemented` |
| No wildcard arms on owned enums | `clippy::wildcard_enum_match_arm` |
| Suppressions need reasons | `clippy::allow_attributes_without_reason` |
| `SAFETY:` on unsafe | `clippy::undocumented_unsafe_blocks`, `rust::unsafe_code = "forbid"` |
| Boolean parameters and fields | `clippy::fn_params_excessive_bools`, `clippy::struct_excessive_bools` (pedantic) |
| Names that repeat the module | `clippy::module_name_repetitions` (pedantic) |
| Cheap clones look cheap | `clippy::clone_on_ref_ptr` |
| Length and complexity | `clippy::too_many_lines`, `cognitive-complexity-threshold` |
