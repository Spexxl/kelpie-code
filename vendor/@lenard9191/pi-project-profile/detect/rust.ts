import type { Builder } from "./context.ts";
import { parseToolVersions, tomlHasTable, tomlKeys, tomlSections } from "./context.ts";

const CRATES: Array<[string, string]> = [
  ["tokio", "Tokio"],
  ["async-std", "async-std"],
  ["axum", "Axum"],
  ["actix-web", "Actix Web"],
  ["rocket", "Rocket"],
  ["warp", "Warp"],
  ["tonic", "Tonic (gRPC)"],
  ["hyper", "Hyper"],
  ["reqwest", "reqwest"],
  ["serde", "Serde"],
  ["clap", "Clap"],
  ["bevy", "Bevy"],
  ["tauri", "Tauri"],
  ["wasm-bindgen", "wasm-bindgen"],
  ["diesel", "Diesel"],
  ["sqlx", "SQLx"],
  ["sea-orm", "SeaORM"],
  ["anyhow", "anyhow"],
  ["thiserror", "thiserror"],
  ["tracing", "tracing"],
  ["rayon", "Rayon"],
  ["pyo3", "PyO3"],
  ["napi", "napi-rs"],
  ["egui", "egui"],
  ["iced", "Iced"],
  ["ratatui", "Ratatui"],
  ["leptos", "Leptos"],
  ["dioxus", "Dioxus"],
  ["yew", "Yew"],
  ["criterion", "Criterion"],
  ["proptest", "proptest"],
  ["insta", "insta"],
];

export function detectRust(b: Builder): void {
  if (!b.hasFile("Cargo.toml")) return;
  const cargo = b.text("Cargo.toml");
  b.lang("Rust");
  const sections = tomlSections(cargo);
  const pkg = sections.get("package");
  const isWorkspace = tomlHasTable(cargo, "workspace");
  const edition = pkg?.["edition"] ?? sections.get("workspace.package")?.["edition"];
  const rustVersion = pkg?.["rust-version"] ?? sections.get("workspace.package")?.["rust-version"];
  const toolchainToml = b.text("rust-toolchain.toml");
  const toolchain = toolchainToml ? tomlSections(toolchainToml).get("toolchain")?.["channel"] : b.text("rust-toolchain")?.trim();
  const toolVersions = parseToolVersions(b.text(".tool-versions"));
  b.runtime("rust", toolchain ?? toolVersions["rust"] ?? (rustVersion ? `≥${rustVersion}` : undefined));
  if (edition) b.add(`edition ${edition}`);

  let members: string[] = [];
  if (isWorkspace) {
    const raw = cargo?.match(/^\s*members\s*=\s*\[([^\]]*)\]/ms)?.[1] ?? "";
    members = Array.from(raw.matchAll(/"([^"]+)"/g)).map((m) => m[1]!);
    b.add(`cargo workspace${members.length ? ` (${members.length} member globs)` : ""}`);
    b.monorepo = { kind: "cargo workspace", packages: members.length || undefined };
  }
  const deps = [
    ...tomlKeys(cargo, "dependencies"),
    ...tomlKeys(cargo, "dev-dependencies"),
    ...tomlKeys(cargo, "workspace.dependencies"),
  ];
  for (const [crate, label] of CRATES) if (deps.includes(crate)) b.add(label);
  if (b.hasFile("build.rs")) b.note("has build.rs (custom build script runs during cargo check/build)");
  if (b.hasFile("rustfmt.toml") || b.hasFile(".rustfmt.toml")) b.convention("rustfmt.toml");
  if (b.hasFile("clippy.toml") || b.hasFile(".clippy.toml") || tomlHasTable(cargo, "lints")) b.convention("Clippy lints configured");
  if (b.hasFile("deny.toml")) b.convention("cargo-deny");
  if (b.hasFile("Cross.toml")) b.add("cross");
  if (b.hasFile(".cargo/config.toml")) b.note(".cargo/config.toml present (custom target/flags)");

  const cargoBin = b.which("cargo");
  const requires = { bin: "cargo", hint: "cargo not found on PATH (install rustup)" };
  b.command("install", "cargo fetch", "cargo");
  b.command("typecheck", "cargo check", "cargo");
  b.command("lint", "cargo clippy --all-targets", "cargo");
  b.command("format", "cargo fmt", "cargo");
  b.command("test", "cargo test", "cargo");
  b.command("test:one", isWorkspace ? "cargo test -p <crate> <test_name>" : "cargo test <test_name>", "cargo");
  b.command("build", "cargo build", "cargo");
  if (pkg && !isWorkspace) b.command("run", "cargo run", "cargo");
  if (!cargoBin) b.note("cargo not on PATH — Rust checks skipped");

  const exts = [".rs", ".toml"];
  b.check({ id: "cargo:check", tier: "fast", label: "typecheck", cmd: "cargo check --all-targets", argv: ["cargo", "check", "--all-targets", "--quiet", "--color", "never"], source: "Cargo.toml", exts, requires, tool: "cargo", scope: { kind: "cargo-check" } });
  b.check({ id: "cargo:fmt", tier: "lint", label: "format", cmd: "cargo fmt --check", argv: ["cargo", "fmt", "--check"], source: "Cargo.toml", exts: [".rs"], requires: { bin: "cargo", hint: "rustfmt component missing (rustup component add rustfmt)" }, tool: "rustfmt" });
  if (b.hasFile("clippy.toml") || b.hasFile(".clippy.toml") || tomlHasTable(cargo, "lints")) {
    b.check({ id: "cargo:clippy", tier: "lint", label: "lint", cmd: "cargo clippy --all-targets", argv: ["cargo", "clippy", "--all-targets", "--quiet", "--color", "never"], source: "clippy config present", exts, requires: { bin: "cargo", hint: "clippy component missing (rustup component add clippy)" }, tool: "cargo" });
  }
  b.check({ id: "cargo:test", tier: "test", label: "test", cmd: "cargo test", argv: ["cargo", "test", "--quiet", "--color", "never"], source: "Cargo.toml", exts, requires, tool: "cargo", scope: isWorkspace ? { kind: "cargo" } : undefined });
}
