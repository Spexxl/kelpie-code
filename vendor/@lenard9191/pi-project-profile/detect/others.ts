/**
 * Detectors for ecosystems that need less nuance than Node/Python:
 * Ruby, JVM, .NET, Swift, PHP, Elixir, Dart/Flutter, C/C++, Zig, Deno, Haskell, Scala, Terraform.
 */
import { join } from "node:path";
import { isExecutable } from "../fs-utils.ts";
import type { Builder } from "./context.ts";
import { parseToolVersions, tomlSections } from "./context.ts";

// ---------------------------------------------------------------- Ruby
export function detectRuby(b: Builder): void {
  if (!b.hasFile("Gemfile") && !b.rootFiles(/\.gemspec$/).length) return;
  b.lang("Ruby");
  const gemfile = (b.text("Gemfile") ?? "") + "\n" + b.rootFiles(/\.gemspec$/).map((f) => b.text(f) ?? "").join("\n");
  const tv = parseToolVersions(b.text(".tool-versions"));
  b.runtime("ruby", b.text(".ruby-version")?.trim() ?? tv["ruby"]);
  const has = (gem: string) => new RegExp(`(^\\s*gem\\s+['"]${gem}['"]|add_(development_)?dependency\\s*\\(?\\s*['"]${gem}['"])`, "m").test(gemfile);
  const isRails = has("rails") || b.hasFile("config/application.rb");
  if (isRails) b.add("Rails");
  if (has("sinatra")) b.add("Sinatra");
  if (has("hanami")) b.add("Hanami");
  if (has("sidekiq")) b.add("Sidekiq");
  const rbDir = (d: string) => b.hasDir(d) && b.files(d).some((f) => f.endsWith(".rb"));
  if (has("rspec") || has("rspec-rails") || rbDir("spec")) b.add("RSpec");
  if (has("minitest") || rbDir("test")) b.add("Minitest");
  if (has("rubocop") || b.hasFile(".rubocop.yml")) b.convention("RuboCop");
  if (has("sorbet") || b.hasFile("sorbet/config")) b.add("Sorbet");
  if (has("standard")) b.convention("Standard Ruby");
  const bundle = b.hasFile("Gemfile.lock") || b.hasFile("Gemfile");
  const bx = (cmd: string) => (bundle ? `bundle exec ${cmd}` : cmd);
  const bxArgv = (cmd: string[]) => (bundle ? ["bundle", "exec", ...cmd] : cmd);
  b.command("install", "bundle install", "Gemfile");
  const req = { bin: "bundle", hint: "bundler not found (gem install bundler)" };
  if (b.hasFile(".rubocop.yml")) {
    b.command("lint", bx("rubocop"), ".rubocop.yml");
    b.check({ id: "rb:rubocop", tier: "lint", label: "lint", cmd: bx("rubocop <files>"), argv: bxArgv(["rubocop", "--format", "simple", "--no-color"]), appendFiles: true, unscopedArgs: [], source: ".rubocop.yml", exts: [".rb", ".rake"], requires: req, tool: "rubocop" });
  }
  if (b.hasFile("sorbet/config")) {
    b.command("typecheck", bx("srb tc"), "sorbet/config");
    b.check({ id: "rb:sorbet", tier: "fast", label: "typecheck", cmd: bx("srb tc"), argv: bxArgv(["srb", "tc", "--no-color"]), source: "sorbet/config", exts: [".rb", ".rbi"], requires: req, tool: "sorbet" });
  }
  if (rbDir("spec") && (has("rspec") || has("rspec-rails") || has("rspec-core"))) {
    b.command("test", bx("rspec"), "spec/");
    b.command("test:one", bx("rspec <file>:<line>"), "rspec");
    b.check({ id: "rb:rspec", tier: "test", label: "test", cmd: bx("rspec"), argv: bxArgv(["rspec", "--no-color", "--fail-fast"]), source: "spec/ + rspec", exts: [".rb", ".erb", ".rake", ".yml"], requires: req, tool: "rspec" });
  } else if (rbDir("test") && b.hasFile("Rakefile")) {
    b.command("test", bx("rake test"), "Rakefile");
    b.command("test:one", b.hasFile("bin/rails") ? "bin/rails test <file>:<line>" : bx("ruby -Itest <file> -n <test_name>"), "minitest");
    b.check({ id: "rb:rake-test", tier: "test", label: "test", cmd: bx("rake test"), argv: bxArgv(["rake", "test"]), source: "Rakefile test/", exts: [".rb", ".erb", ".rake", ".yml"], requires: req, tool: "minitest" });
  }
  if (isRails) {
    b.command("dev", "bin/rails server", "Rails");
    b.command("migrate", "bin/rails db:migrate", "Rails");
    if (b.hasDir("db/migrate")) b.add("ActiveRecord migrations (db/migrate)");
  }
  const ruby = b.which("ruby");
  if (ruby) b.check({ id: "rb:syntax", tier: "syntax", label: "syntax", cmd: "ruby -c <file>", argv: ["ruby", "-c"], appendFiles: true, source: "ruby", exts: [".rb", ".rake"], requires: { bin: "ruby" }, tool: "ruby" });
}

// ---------------------------------------------------------------- JVM (Maven / Gradle)
export function detectJvm(b: Builder): void {
  const gradle = b.first(["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"]);
  const maven = b.hasFile("pom.xml");
  if (!gradle && !maven) return;
  const tv = parseToolVersions(b.text(".tool-versions"));
  b.runtime("java", b.text(".java-version")?.trim() ?? tv["java"] ?? b.text(".sdkmanrc")?.match(/java=(\S+)/)?.[1]);
  const gradleText = gradle ? (b.text("build.gradle.kts") ?? "") + (b.text("build.gradle") ?? "") + (b.text("settings.gradle.kts") ?? "") : "";
  const pom = maven ? b.text("pom.xml") ?? "" : "";
  const all = gradleText + pom;
  const kotlin = /kotlin/i.test(all) || b.rootFiles(/\.kts$/).length > 0;
  const scala = /scala/i.test(gradleText);
  b.lang(kotlin ? "Kotlin" : scala ? "Scala" : "Java");
  if (kotlin && /java/i.test(all)) b.lang("Java");
  if (/spring-boot|org\.springframework\.boot/.test(all)) b.add("Spring Boot");
  else if (/springframework/.test(all)) b.add("Spring");
  if (/com\.android|android\{|android \{/.test(all)) b.add("Android");
  if (/io\.quarkus/.test(all)) b.add("Quarkus");
  if (/io\.micronaut/.test(all)) b.add("Micronaut");
  if (/io\.ktor/.test(all)) b.add("Ktor");
  if (/org\.junit/.test(all)) b.add("JUnit");
  if (/kotest/.test(all)) b.add("Kotest");
  if (/spotless/.test(all)) b.convention("Spotless");
  if (/ktlint/.test(all)) b.convention("ktlint");
  if (/detekt/.test(all)) b.convention("detekt");
  if (/checkstyle/.test(all)) b.convention("Checkstyle");
  if (b.hasFile("settings.gradle.kts") || b.hasFile("settings.gradle")) {
    const includes = (b.text("settings.gradle.kts") ?? b.text("settings.gradle") ?? "").match(/include\s*\(?\s*["':][^)\n]*/g)?.length ?? 0;
    if (includes > 0) b.monorepo = { kind: "gradle multi-project" };
  }
  if (pom.includes("<modules>")) b.monorepo = { kind: "maven multi-module" };

  if (gradle) {
    const wrapper = isExecutable(join(b.root, "gradlew"));
    const g = wrapper ? "./gradlew" : "gradle";
    b.add(`Gradle${wrapper ? " (wrapper)" : ""}${gradle.endsWith(".kts") ? " Kotlin DSL" : ""}`);
    const req = wrapper ? { files: ["gradlew"], hint: "gradlew missing" } : { bin: "gradle", hint: "gradle not on PATH" };
    const argv0 = wrapper ? join(b.root, "gradlew") : "gradle";
    b.command("build", `${g} build`, gradle);
    b.command("test", `${g} test`, gradle);
    b.command("test:one", `${g} test --tests '<Class.method>'`, gradle);
    b.command("typecheck", `${g} compileJava${kotlin ? " compileKotlin" : ""} -q`, gradle);
    if (/spotless/.test(all)) b.command("format", `${g} spotlessApply`, gradle);
    if (/spring-boot/.test(all)) b.command("dev", `${g} bootRun`, gradle);
    const compileTasks = kotlin ? ["compileKotlin", "compileTestKotlin"] : ["compileJava", "compileTestJava"];
    b.check({ id: "gradle:compile", tier: "build", label: "compile", cmd: `${g} ${compileTasks.join(" ")} -q`, argv: [argv0, ...compileTasks, "-q", "--console=plain"], source: gradle, exts: [".java", ".kt", ".kts", ".gradle", ".groovy", ".scala"], requires: req, tool: "gradle" });
    b.check({ id: "gradle:test", tier: "test", label: "test", cmd: `${g} test`, argv: [argv0, "test", "--console=plain"], source: gradle, exts: [".java", ".kt", ".kts", ".gradle", ".groovy", ".scala", ".xml", ".properties", ".yml"], requires: req, tool: "gradle" });
  } else if (maven) {
    const wrapper = isExecutable(join(b.root, "mvnw"));
    const m = wrapper ? "./mvnw" : "mvn";
    const argv0 = wrapper ? join(b.root, "mvnw") : "mvn";
    b.add(`Maven${wrapper ? " (wrapper)" : ""}`);
    const req = wrapper ? { files: ["mvnw"] } : { bin: "mvn", hint: "mvn not on PATH" };
    b.command("build", `${m} -q package -DskipTests`, "pom.xml");
    b.command("test", `${m} -q test`, "pom.xml");
    b.command("test:one", `${m} -q test -Dtest='<Class#method>'`, "pom.xml");
    b.command("typecheck", `${m} -q compile`, "pom.xml");
    if (/spring-boot/.test(all)) b.command("dev", `${m} spring-boot:run`, "pom.xml");
    b.check({ id: "maven:compile", tier: "build", label: "compile", cmd: `${m} -q -B test-compile`, argv: [argv0, "-q", "-B", "test-compile"], source: "pom.xml", exts: [".java", ".kt", ".xml", ".scala"], requires: req, tool: "maven" });
    b.check({ id: "maven:test", tier: "test", label: "test", cmd: `${m} -q -B test`, argv: [argv0, "-q", "-B", "test"], source: "pom.xml", exts: [".java", ".kt", ".xml", ".properties", ".yml", ".scala"], requires: req, tool: "maven" });
  }
}

// ---------------------------------------------------------------- .NET
export function detectDotnet(b: Builder): void {
  const sln = b.rootFiles(/\.slnx?$/);
  const proj = b.rootFiles(/\.(cs|fs|vb)proj$/);
  if (sln.length === 0 && proj.length === 0) return;
  b.lang(proj.some((p) => p.endsWith(".fsproj")) ? "F#" : "C#");
  b.add(".NET");
  const global = b.json<any>("global.json");
  b.runtime("dotnet", global?.sdk?.version);
  const target = sln[0] ?? proj[0]!;
  const all = proj.map((p) => b.text(p) ?? "").join("\n");
  if (/Microsoft\.AspNetCore|Sdk="Microsoft\.NET\.Sdk\.Web"/.test(all)) b.add("ASP.NET Core");
  if (/xunit/i.test(all)) b.add("xUnit");
  if (/nunit/i.test(all)) b.add("NUnit");
  if (/MSTest/i.test(all)) b.add("MSTest");
  if (/EntityFrameworkCore/.test(all)) b.add("EF Core");
  if (/Blazor|Microsoft\.AspNetCore\.Components/.test(all)) b.add("Blazor");
  if (/Avalonia/.test(all)) b.add("Avalonia");
  if (/MAUI|UseMaui/.test(all)) b.add(".NET MAUI");
  if (b.hasFile(".editorconfig")) b.convention("dotnet format (.editorconfig)");
  const req = { bin: "dotnet", hint: "dotnet SDK not on PATH" };
  b.command("install", `dotnet restore ${target}`, target);
  b.command("build", `dotnet build ${target}`, target);
  b.command("test", `dotnet test ${target}`, target);
  b.command("test:one", `dotnet test ${target} --filter <Name>`, target);
  b.command("format", `dotnet format ${target}`, target);
  b.check({ id: "dotnet:build", tier: "build", label: "build", cmd: `dotnet build ${target} --nologo`, argv: ["dotnet", "build", target, "--nologo", "-v", "q", "-clp:NoSummary"], source: target, exts: [".cs", ".fs", ".vb", ".csproj", ".fsproj", ".props", ".targets", ".razor", ".cshtml", ".json"], requires: req, tool: "dotnet" });
  b.check({ id: "dotnet:test", tier: "test", label: "test", cmd: `dotnet test ${target} --nologo`, argv: ["dotnet", "test", target, "--nologo", "-v", "q"], source: target, exts: [".cs", ".fs", ".vb", ".csproj", ".fsproj", ".json"], requires: req, tool: "dotnet" });
}

// ---------------------------------------------------------------- Swift
export function detectSwift(b: Builder): void {
  const spm = b.hasFile("Package.swift");
  const xcodeproj = b.ls().filter((f) => /\.(xcodeproj|xcworkspace)$/.test(f));
  if (!spm && xcodeproj.length === 0) return;
  b.lang("Swift");
  const tv = parseToolVersions(b.text(".tool-versions"));
  b.runtime("swift", b.text(".swift-version")?.trim() ?? tv["swift"] ?? b.text("Package.swift")?.match(/swift-tools-version:\s*([\d.]+)/)?.[1]);
  const pkg = b.text("Package.swift") ?? "";
  if (spm) b.add("Swift Package Manager");
  if (xcodeproj.length) b.add(`Xcode (${xcodeproj.join(", ")})`);
  if (/swift-argument-parser/.test(pkg)) b.add("ArgumentParser");
  if (/vapor/.test(pkg)) b.add("Vapor");
  if (/swift-nio/.test(pkg)) b.add("SwiftNIO");
  if (/\bTesting\b|swift-testing/.test(pkg)) b.add("Swift Testing");
  if (/XCTest|testTarget/.test(pkg)) b.add("XCTest");
  if (b.hasFile(".swiftlint.yml")) b.convention("SwiftLint");
  if (b.hasFile(".swift-format")) b.convention("swift-format");
  if (b.hasFile("Podfile")) b.add("CocoaPods");
  if (b.hasFile("Cartfile")) b.add("Carthage");
  if (b.hasFile("project.yml")) b.add("XcodeGen");
  if (b.hasFile("Tuist.swift") || b.hasFile("Project.swift")) b.add("Tuist");
  if (b.hasFile("fastlane/Fastfile")) b.add("fastlane");
  if (spm) {
    const req = { bin: "swift", hint: "swift toolchain not on PATH" };
    b.command("build", "swift build", "Package.swift");
    b.command("test", "swift test", "Package.swift");
    b.command("test:one", "swift test --filter <TestClass/testMethod>", "Package.swift");
    b.check({ id: "swift:build", tier: "build", label: "build", cmd: "swift build", argv: ["swift", "build"], source: "Package.swift", exts: [".swift"], requires: req, tool: "swift" });
    b.check({ id: "swift:test", tier: "test", label: "test", cmd: "swift test", argv: ["swift", "test"], source: "Package.swift", exts: [".swift"], requires: req, tool: "swift" });
  } else {
    b.command("build", `xcodebuild -scheme <scheme> build`, xcodeproj[0]!);
    b.command("test", `xcodebuild -scheme <scheme> test`, xcodeproj[0]!);
    b.note("Xcode project: resolve the scheme with `xcodebuild -list` before building");
  }
  if (b.hasFile(".swiftlint.yml") && b.which("swiftlint")) {
    b.command("lint", "swiftlint", ".swiftlint.yml");
    b.check({ id: "swift:lint", tier: "lint", label: "lint", cmd: "swiftlint lint --quiet <files>", argv: ["swiftlint", "lint", "--quiet", "--no-cache"], appendFiles: true, unscopedArgs: [], source: ".swiftlint.yml", exts: [".swift"], requires: { bin: "swiftlint" }, tool: "swiftlint" });
  }
  if (b.hasFile(".swift-format") && b.which("swift-format")) {
    b.check({ id: "swift:format", tier: "lint", label: "format", cmd: "swift-format lint --strict <files>", argv: ["swift-format", "lint", "--strict"], appendFiles: true, unscopedArgs: ["-r", "."], source: ".swift-format", exts: [".swift"], requires: { bin: "swift-format" }, tool: "swift-format" });
  }
}

// ---------------------------------------------------------------- PHP
export function detectPhp(b: Builder): void {
  if (!b.hasFile("composer.json")) return;
  const composer = b.json<any>("composer.json") ?? {};
  const deps = { ...composer.require, ...composer["require-dev"] };
  const has = (d: string) => Object.hasOwn(deps, d);
  b.lang("PHP");
  b.runtime("php", typeof deps["php"] === "string" ? deps["php"] : undefined);
  b.add("Composer");
  if (has("laravel/framework")) b.add("Laravel");
  if (Object.keys(deps).some((d) => d.startsWith("symfony/")) && !has("laravel/framework")) b.add("Symfony");
  if (has("slim/slim")) b.add("Slim");
  if (has("phpunit/phpunit")) b.add("PHPUnit");
  if (has("pestphp/pest")) b.add("Pest");
  if (has("phpstan/phpstan") || b.hasFile("phpstan.neon") || b.hasFile("phpstan.neon.dist")) b.convention("PHPStan");
  if (has("vimeo/psalm")) b.convention("Psalm");
  if (has("laravel/pint")) b.convention("Pint");
  if (has("friendsofphp/php-cs-fixer")) b.convention("PHP CS Fixer");
  if (has("squizlabs/php_codesniffer")) b.convention("PHP_CodeSniffer");
  const vendorBin = (tool: string) => (isExecutable(join(b.root, "vendor", "bin", tool)) ? join(b.root, "vendor", "bin", tool) : undefined);
  const hint = "vendor/ missing — run `composer install`";
  b.command("install", "composer install", "composer.json");
  const php = b.which("php");
  if (php) b.check({ id: "php:syntax", tier: "syntax", label: "syntax", cmd: "php -l <file>", argv: ["php", "-l"], appendFiles: true, source: "php", exts: [".php"], requires: { bin: "php" }, tool: "php" });
  if (has("phpstan/phpstan") || b.hasFile("phpstan.neon") || b.hasFile("phpstan.neon.dist")) {
    b.command("typecheck", "vendor/bin/phpstan analyse", "phpstan");
    const bin = vendorBin("phpstan");
    b.check({ id: "php:phpstan", tier: "fast", label: "analyse", cmd: "vendor/bin/phpstan analyse --no-progress <files>", argv: [bin ?? join(b.root, "vendor", "bin", "phpstan"), "analyse", "--no-progress", "--no-ansi", "--error-format=raw"], appendFiles: true, unscopedArgs: [], source: "phpstan", exts: [".php"], requires: { files: ["vendor/bin/phpstan"], hint }, tool: "phpstan" });
  } else if (has("vimeo/psalm")) {
    b.command("typecheck", "vendor/bin/psalm", "psalm");
    b.check({ id: "php:psalm", tier: "fast", label: "analyse", cmd: "vendor/bin/psalm --no-progress <files>", argv: [join(b.root, "vendor", "bin", "psalm"), "--no-progress", "--output-format=compact"], appendFiles: true, unscopedArgs: [], source: "psalm", exts: [".php"], requires: { files: ["vendor/bin/psalm"], hint }, tool: "psalm" });
  }
  if (has("laravel/pint")) {
    b.command("format", "vendor/bin/pint", "pint");
    b.check({ id: "php:pint", tier: "lint", label: "format", cmd: "vendor/bin/pint --test <files>", argv: [join(b.root, "vendor", "bin", "pint"), "--test", "--no-ansi"], appendFiles: true, unscopedArgs: [], source: "pint", exts: [".php"], requires: { files: ["vendor/bin/pint"], hint }, tool: "pint" });
  } else if (has("friendsofphp/php-cs-fixer")) {
    b.command("format", "vendor/bin/php-cs-fixer fix", "php-cs-fixer");
    b.check({ id: "php:cs-fixer", tier: "lint", label: "format", cmd: "vendor/bin/php-cs-fixer check <files>", argv: [join(b.root, "vendor", "bin", "php-cs-fixer"), "check", "--no-ansi", "--show-progress=none"], appendFiles: true, unscopedArgs: [], source: "php-cs-fixer", exts: [".php"], requires: { files: ["vendor/bin/php-cs-fixer"], hint }, tool: "php-cs-fixer" });
  }
  if (has("pestphp/pest")) {
    b.command("test", "vendor/bin/pest", "pest");
    b.command("test:one", 'vendor/bin/pest --filter "<name>"', "pest");
    b.check({ id: "php:pest", tier: "test", label: "test", cmd: "vendor/bin/pest", argv: [join(b.root, "vendor", "bin", "pest"), "--no-ansi", "--stop-on-failure"], source: "pest", exts: [".php", ".xml", ".env"], requires: { files: ["vendor/bin/pest"], hint }, tool: "phpunit" });
  } else if (has("phpunit/phpunit")) {
    b.command("test", has("laravel/framework") ? "php artisan test" : "vendor/bin/phpunit", "phpunit");
    b.command("test:one", has("laravel/framework") ? "php artisan test --filter <name>" : "vendor/bin/phpunit --filter <name>", "phpunit");
    b.check({ id: "php:phpunit", tier: "test", label: "test", cmd: "vendor/bin/phpunit", argv: [join(b.root, "vendor", "bin", "phpunit"), "--no-progress", "--colors=never", "--stop-on-failure"], source: "phpunit", exts: [".php", ".xml", ".env"], requires: { files: ["vendor/bin/phpunit"], hint }, tool: "phpunit" });
  }
  if (has("laravel/framework")) {
    b.command("dev", "php artisan serve", "Laravel");
    b.command("migrate", "php artisan migrate", "Laravel");
  }
}

// ---------------------------------------------------------------- Elixir
export function detectElixir(b: Builder): void {
  if (!b.hasFile("mix.exs")) return;
  b.lang("Elixir");
  const mix = b.text("mix.exs") ?? "";
  const tv = parseToolVersions(b.text(".tool-versions"));
  b.runtime("elixir", tv["elixir"] ?? mix.match(/elixir:\s*"([^"]+)"/)?.[1]);
  b.runtime("erlang", tv["erlang"]);
  b.add("Mix");
  if (/:phoenix\b/.test(mix)) b.add("Phoenix");
  if (/:phoenix_live_view/.test(mix)) b.add("LiveView");
  if (/:ecto/.test(mix)) b.add("Ecto");
  if (/:credo/.test(mix)) b.convention("Credo");
  if (/:dialyxir/.test(mix)) b.add("Dialyzer");
  if (/:ex_unit|ExUnit/.test(mix) || b.hasDir("test")) b.add("ExUnit");
  if (/apps_path:/.test(mix)) b.monorepo = { kind: "umbrella app" };
  const req = { bin: "mix", hint: "mix (Elixir) not on PATH" };
  b.command("install", "mix deps.get", "mix.exs");
  b.command("typecheck", "mix compile --warnings-as-errors", "mix.exs");
  b.command("format", "mix format", "mix.exs");
  b.command("test", "mix test", "mix.exs");
  b.command("test:one", "mix test <file>:<line>", "mix.exs");
  if (/:credo\b/.test(mix)) b.command("lint", "mix credo", "credo");
  if (/:phoenix\b/.test(mix)) b.command("dev", "mix phx.server", "Phoenix");
  if (/:ecto_sql/.test(mix)) b.command("migrate", "mix ecto.migrate", "Ecto");
  b.check({ id: "mix:compile", tier: "fast", label: "compile", cmd: "mix compile --warnings-as-errors", argv: ["mix", "compile", "--warnings-as-errors"], source: "mix.exs", exts: [".ex", ".exs", ".eex", ".heex"], requires: req, tool: "mix" });
  b.check({ id: "mix:format", tier: "lint", label: "format", cmd: "mix format --check-formatted <files>", argv: ["mix", "format", "--check-formatted"], appendFiles: true, unscopedArgs: [], source: "mix.exs", exts: [".ex", ".exs", ".heex"], requires: req, tool: "mix" });
  if (/:credo\b/.test(mix)) b.check({ id: "mix:credo", tier: "lint", label: "lint", cmd: "mix credo --strict", argv: ["mix", "credo", "--strict", "--format", "oneline"], source: "credo", exts: [".ex", ".exs"], requires: req, tool: "credo" });
  b.check({ id: "mix:test", tier: "test", label: "test", cmd: "mix test", argv: ["mix", "test", "--max-failures", "5"], source: "mix.exs", exts: [".ex", ".exs", ".eex", ".heex"], requires: req, tool: "exunit" });
}

// ---------------------------------------------------------------- Dart / Flutter
export function detectDart(b: Builder): void {
  if (!b.hasFile("pubspec.yaml")) return;
  const pub = b.text("pubspec.yaml") ?? "";
  const flutter = /^\s*flutter:\s*$/m.test(pub) || /sdk:\s*flutter/.test(pub) || b.hasDir("android") && b.hasDir("ios");
  b.lang("Dart");
  if (flutter) b.add("Flutter");
  b.runtime("dart", pub.match(/sdk:\s*['"]?([^'"\n]+)/)?.[1]?.trim());
  if (/riverpod/.test(pub)) b.add("Riverpod");
  if (/flutter_bloc|\bbloc:/.test(pub)) b.add("BLoC");
  if (/provider:/.test(pub)) b.add("Provider");
  if (/go_router/.test(pub)) b.add("go_router");
  if (/build_runner/.test(pub)) b.add("build_runner");
  if (/freezed/.test(pub)) b.add("freezed");
  if (b.hasFile("analysis_options.yaml")) b.convention("analysis_options.yaml");
  const tool = flutter ? "flutter" : "dart";
  const req = { bin: tool, hint: `${tool} not on PATH` };
  b.command("install", `${tool} pub get`, "pubspec.yaml");
  b.command("typecheck", `${tool} analyze`, "pubspec.yaml");
  b.command("format", "dart format .", "pubspec.yaml");
  b.command("test", `${tool} test`, "pubspec.yaml");
  b.command("test:one", `${tool} test <file> --plain-name "<name>"`, "pubspec.yaml");
  if (flutter) b.command("run", "flutter run", "pubspec.yaml");
  if (/build_runner/.test(pub)) b.command("build", `${tool} run build_runner build`, "build_runner");
  b.check({ id: "dart:analyze", tier: "fast", label: "analyze", cmd: `${tool} analyze`, argv: [tool, "analyze", "--no-fatal-warnings"], source: "pubspec.yaml", exts: [".dart", ".yaml"], requires: req, tool: "dart" });
  b.check({ id: "dart:format", tier: "lint", label: "format", cmd: "dart format --output=none --set-exit-if-changed <files>", argv: ["dart", "format", "--output=none", "--set-exit-if-changed"], appendFiles: true, unscopedArgs: ["."], source: "dart", exts: [".dart"], requires: { bin: "dart", hint: "dart not on PATH" }, tool: "dart" });
  b.check({ id: "dart:test", tier: "test", label: "test", cmd: `${tool} test`, argv: [tool, "test", "--reporter", "compact"], source: "pubspec.yaml", exts: [".dart", ".yaml"], requires: req, tool: "dart" });
}

// ---------------------------------------------------------------- C / C++ / Zig / native build systems
export function detectNative(b: Builder): void {
  const cmake = b.hasFile("CMakeLists.txt");
  const meson = b.hasFile("meson.build");
  const zig = b.hasFile("build.zig");
  const autotools = b.hasFile("configure.ac") || b.hasFile("configure");
  const hasCSources = b.rootFiles(/\.(c|cc|cpp|cxx|h|hpp)$/).length > 0 || ["src", "lib", "include"].some((d) => b.hasDir(d) && b.files(d).some((f) => /\.(c|cc|cpp|cxx|h|hpp)$/.test(f)));
  if (zig) {
    b.lang("Zig");
    b.runtime("zig", b.text(".zigversion")?.trim() ?? b.text("build.zig.zon")?.match(/minimum_zig_version\s*=\s*"([^"]+)"/)?.[1]);
    const req = { bin: "zig", hint: "zig not on PATH" };
    b.command("build", "zig build", "build.zig");
    b.command("test", "zig build test", "build.zig");
    b.command("format", "zig fmt .", "zig");
    b.check({ id: "zig:fmt", tier: "lint", label: "format", cmd: "zig fmt --check <files>", argv: ["zig", "fmt", "--check"], appendFiles: true, unscopedArgs: ["."], source: "zig", exts: [".zig", ".zon"], requires: req, tool: "zig" });
    b.check({ id: "zig:build", tier: "build", label: "build", cmd: "zig build", argv: ["zig", "build", "--color", "off"], source: "build.zig", exts: [".zig", ".zon", ".c", ".h"], requires: req, tool: "zig" });
    b.check({ id: "zig:test", tier: "test", label: "test", cmd: "zig build test", argv: ["zig", "build", "test", "--color", "off"], source: "build.zig", exts: [".zig", ".zon"], requires: req, tool: "zig" });
  }
  if (!cmake && !meson && !autotools && !hasCSources) return;
  {
    const cm = b.text("CMakeLists.txt") ?? "";
    const ms = b.text("meson.build") ?? "";
    const cmakeLangs = cm.match(/LANGUAGES\s+([^)\n]+)/)?.[1] ?? "";
    const cmakeOnlyOther = cmakeLangs !== "" && !/\b(C|CXX)\b/.test(cmakeLangs);
    const cpp = b.rootFiles(/\.(cc|cpp|cxx|hpp)$/).length > 0 || /\bCXX\b|cxx_std|project\([^)]*CXX/.test(cm) || /'cpp'/.test(ms);
    if (hasCSources || ((cmake || meson || autotools) && !cmakeOnlyOther)) b.lang(cpp ? "C++" : "C");
  }
  if (b.hasFile(".clang-format")) b.convention("clang-format");
  if (b.hasFile(".clang-tidy")) b.convention("clang-tidy");
  if (b.hasFile("compile_commands.json")) b.note("compile_commands.json at root");
  if (b.hasFile("conanfile.txt") || b.hasFile("conanfile.py")) b.add("Conan");
  if (b.hasFile("vcpkg.json")) b.add("vcpkg");
  if (cmake) {
    b.add("CMake");
    const cm = b.text("CMakeLists.txt") ?? "";
    const std = cm.match(/CMAKE_CXX_STANDARD\s+(\d+)/)?.[1];
    if (std) b.add(`C++${std}`);
    if (/enable_testing|add_test|CTest/.test(cm)) b.add("CTest");
    if (/FetchContent|find_package\(\s*(GTest|Catch2|doctest)/i.test(cm)) {
      if (/GTest|gtest/i.test(cm)) b.add("GoogleTest");
      if (/Catch2/i.test(cm)) b.add("Catch2");
      if (/doctest/i.test(cm)) b.add("doctest");
    }
    const presets = b.hasFile("CMakePresets.json");
    if (presets) b.add("CMakePresets.json");
    const buildDir = ["build", "cmake-build-debug", "cmake-build-release", "out/build", "_build"].find((d) => b.hasFile(join(d, "CMakeCache.txt")));
    b.command("build", buildDir ? `cmake --build ${buildDir}` : "cmake -S . -B build && cmake --build build", "CMakeLists.txt");
    b.command("test", buildDir ? `ctest --test-dir ${buildDir} --output-on-failure` : "ctest --test-dir build --output-on-failure", "CMakeLists.txt");
    if (buildDir) {
      const req = { bin: "cmake", hint: "cmake not on PATH" };
      b.check({ id: "cmake:build", tier: "build", label: "build", cmd: `cmake --build ${buildDir}`, argv: ["cmake", "--build", buildDir], source: `${buildDir}/CMakeCache.txt`, exts: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".txt", ".cmake"], requires: req, tool: "cmake" });
      if (b.hasFile(join(buildDir, "CTestTestfile.cmake"))) b.check({ id: "cmake:test", tier: "test", label: "test", cmd: `ctest --test-dir ${buildDir} --output-on-failure`, argv: ["ctest", "--test-dir", buildDir, "--output-on-failure"], source: "CTest", exts: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"], requires: { bin: "ctest" }, tool: "ctest" });
    } else b.note("no configured CMake build dir found (expected build/CMakeCache.txt); build checks disabled");
  } else if (meson) {
    b.add("Meson");
    const buildDir = ["build", "builddir", "_build"].find((d) => b.hasFile(join(d, "meson-info", "meson-info.json")));
    b.command("build", buildDir ? `meson compile -C ${buildDir}` : "meson setup build && meson compile -C build", "meson.build");
    b.command("test", buildDir ? `meson test -C ${buildDir}` : "meson test -C build", "meson.build");
    if (buildDir) {
      b.check({ id: "meson:build", tier: "build", label: "build", cmd: `meson compile -C ${buildDir}`, argv: ["meson", "compile", "-C", buildDir], source: "meson.build", exts: [".c", ".cc", ".cpp", ".h", ".hpp", ".build"], requires: { bin: "meson" }, tool: "meson" });
      b.check({ id: "meson:test", tier: "test", label: "test", cmd: `meson test -C ${buildDir}`, argv: ["meson", "test", "-C", buildDir, "--print-errorlogs"], source: "meson.build", exts: [".c", ".cc", ".cpp", ".h", ".hpp"], requires: { bin: "meson" }, tool: "meson" });
    }
  } else if (autotools) {
    b.add("Autotools");
    b.command("build", b.hasFile("Makefile") ? "make" : "./configure && make", "configure");
    b.command("test", "make check", "configure");
  }
  if (b.hasFile(".clang-format") && b.which("clang-format")) {
    b.check({ id: "c:clang-format", tier: "lint", label: "format", cmd: "clang-format --dry-run --Werror <files>", argv: ["clang-format", "--dry-run", "--Werror"], appendFiles: true, source: ".clang-format", exts: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".m", ".mm"], requires: { bin: "clang-format" }, tool: "clang-format" });
  }
}

// ---------------------------------------------------------------- Deno
export function detectDeno(b: Builder): void {
  const cfg = b.first(["deno.json", "deno.jsonc"]);
  if (!cfg) return;
  b.lang("TypeScript");
  b.add("Deno");
  const conf = b.json<any>(cfg) ?? {};
  const tasks = conf.tasks ?? {};
  for (const [k, v] of Object.entries(tasks)) {
    const key = /^(test|lint|fmt|format|check|typecheck|build|dev|start)$/.test(k) ? k.replace("fmt", "format").replace("start", "dev").replace("check", "typecheck") : undefined;
    if (key) b.command(key, `deno task ${k}`, `${cfg} tasks.${k}`);
    void v;
  }
  if (/fresh/.test(JSON.stringify(conf.imports ?? {}))) b.add("Fresh");
  const req = { bin: "deno", hint: "deno not on PATH" };
  b.command("typecheck", "deno check **/*.ts", cfg);
  b.command("lint", "deno lint", cfg);
  b.command("format", "deno fmt", cfg);
  b.command("test", "deno test", cfg);
  b.command("test:one", 'deno test <file> --filter "<name>"', cfg);
  b.check({ id: "deno:check", tier: "fast", label: "typecheck", cmd: "deno check <files>", argv: ["deno", "check"], appendFiles: true, unscopedArgs: ["."], source: cfg, exts: [".ts", ".tsx", ".mts"], requires: req, tool: "deno" });
  b.check({ id: "deno:lint", tier: "lint", label: "lint", cmd: "deno lint <files>", argv: ["deno", "lint"], appendFiles: true, unscopedArgs: [], source: cfg, exts: [".ts", ".tsx", ".js", ".jsx", ".mts"], requires: req, tool: "deno" });
  b.check({ id: "deno:fmt", tier: "lint", label: "format", cmd: "deno fmt --check <files>", argv: ["deno", "fmt", "--check"], appendFiles: true, unscopedArgs: [], source: cfg, exts: [".ts", ".tsx", ".js", ".jsx", ".json", ".md"], requires: req, tool: "deno" });
  b.check({ id: "deno:test", tier: "test", label: "test", cmd: tasks.test ? "deno task test" : "deno test -A", argv: tasks.test ? ["deno", "task", "test"] : ["deno", "test", "-A"], source: cfg, exts: [".ts", ".tsx", ".js", ".json"], requires: req, tool: "deno" });
}

// ---------------------------------------------------------------- Haskell / Scala / OCaml / Nim / Kotlin-native etc.
export function detectFunctional(b: Builder): void {
  const cabal = b.rootFiles(/\.cabal$/);
  if (cabal.length || b.hasFile("cabal.project") || b.hasFile("stack.yaml") || b.hasFile("package.yaml")) {
    b.lang("Haskell");
    const stack = b.hasFile("stack.yaml");
    b.add(stack ? "Stack" : "Cabal");
    if (b.hasFile("package.yaml")) b.add("hpack");
    const tool = stack ? "stack" : "cabal";
    const req = { bin: tool, hint: `${tool} not on PATH` };
    b.command("build", `${tool} build`, stack ? "stack.yaml" : "cabal");
    b.command("test", `${tool} test`, stack ? "stack.yaml" : "cabal");
    if (b.hasFile(".hlint.yaml")) b.convention("hlint");
    if (b.hasFile("fourmolu.yaml")) b.convention("fourmolu");
    b.check({ id: `hs:build`, tier: "build", label: "build", cmd: `${tool} build`, argv: [tool, "build"], source: tool, exts: [".hs", ".cabal", ".yaml"], requires: req, tool });
    b.check({ id: `hs:test`, tier: "test", label: "test", cmd: `${tool} test`, argv: [tool, "test"], source: tool, exts: [".hs", ".cabal", ".yaml"], requires: req, tool });
  }
  if (b.hasFile("build.sbt")) {
    b.lang("Scala");
    b.add("sbt");
    const sbt = b.text("build.sbt") ?? "";
    b.runtime("scala", sbt.match(/scalaVersion\s*:=\s*"([^"]+)"/)?.[1]);
    if (/scalafmt/.test(sbt) || b.hasFile(".scalafmt.conf")) b.convention("scalafmt");
    if (/zio/.test(sbt)) b.add("ZIO");
    if (/cats-effect/.test(sbt)) b.add("Cats Effect");
    if (/akka|pekko/.test(sbt)) b.add("Akka/Pekko");
    if (/play/.test(sbt)) b.add("Play");
    const req = { bin: "sbt", hint: "sbt not on PATH" };
    b.command("build", "sbt compile", "build.sbt");
    b.command("test", "sbt test", "build.sbt");
    b.check({ id: "sbt:compile", tier: "build", label: "compile", cmd: "sbt -batch compile Test/compile", argv: ["sbt", "-batch", "-Dsbt.color=false", "compile", "Test/compile"], source: "build.sbt", exts: [".scala", ".sbt", ".java"], requires: req, tool: "sbt" });
    b.check({ id: "sbt:test", tier: "test", label: "test", cmd: "sbt -batch test", argv: ["sbt", "-batch", "-Dsbt.color=false", "test"], source: "build.sbt", exts: [".scala", ".sbt", ".java", ".conf"], requires: req, tool: "sbt" });
  }
  if (b.hasFile("dune-project")) {
    b.lang("OCaml");
    b.add("dune");
    const req = { bin: "dune", hint: "dune not on PATH" };
    b.command("build", "dune build", "dune-project");
    b.command("test", "dune test", "dune-project");
    b.command("format", "dune fmt", "dune-project");
    b.check({ id: "dune:build", tier: "build", label: "build", cmd: "dune build", argv: ["dune", "build", "--display=short"], source: "dune-project", exts: [".ml", ".mli", ".dune"], requires: req, tool: "dune" });
    b.check({ id: "dune:test", tier: "test", label: "test", cmd: "dune test", argv: ["dune", "test", "--display=short"], source: "dune-project", exts: [".ml", ".mli", ".dune"], requires: req, tool: "dune" });
  }
  if (b.rootFiles(/\.nimble$/).length) {
    b.lang("Nim");
    b.command("build", "nimble build", "nimble");
    b.command("test", "nimble test", "nimble");
  }
  if (b.hasFile("Project.toml") && b.hasDir("src") && b.files("src").some((f) => f.endsWith(".jl"))) {
    b.lang("Julia");
    b.command("test", 'julia --project -e "using Pkg; Pkg.test()"', "Project.toml");
  }
  if (b.hasFile("DESCRIPTION") && /^Package:/m.test(b.text("DESCRIPTION") ?? "")) {
    b.lang("R");
    b.command("test", 'Rscript -e "devtools::test()"', "DESCRIPTION");
  }
  if (b.hasFile("rebar.config")) {
    b.lang("Erlang");
    b.add("rebar3");
    b.command("build", "rebar3 compile", "rebar.config");
    b.command("test", "rebar3 eunit", "rebar.config");
  }
  if (b.hasFile("gleam.toml")) {
    b.lang("Gleam");
    b.command("build", "gleam build", "gleam.toml");
    b.command("test", "gleam test", "gleam.toml");
    b.check({ id: "gleam:build", tier: "fast", label: "build", cmd: "gleam build", argv: ["gleam", "build"], source: "gleam.toml", exts: [".gleam", ".toml"], requires: { bin: "gleam" }, tool: "gleam" });
    b.check({ id: "gleam:test", tier: "test", label: "test", cmd: "gleam test", argv: ["gleam", "test"], source: "gleam.toml", exts: [".gleam", ".toml"], requires: { bin: "gleam" }, tool: "gleam" });
  }
}

// ---------------------------------------------------------------- Infra & scripting
export function detectInfra(b: Builder): void {
  const tf = b.rootFiles(/\.tf$/);
  if (tf.length) {
    b.lang("HCL (Terraform)");
    const isTofu = b.hasFile(".opentofu-version") || b.hasFile(".tofu-version");
    const tool = isTofu ? "tofu" : "terraform";
    b.add(isTofu ? "OpenTofu" : "Terraform");
    b.runtime(tool, b.text(".terraform-version")?.trim() ?? b.text(".opentofu-version")?.trim() ?? parseToolVersions(b.text(".tool-versions"))[tool]);
    if (b.hasFile(".tflint.hcl")) b.convention("tflint");
    const req = { bin: tool, hint: `${tool} not on PATH` };
    b.command("format", `${tool} fmt -recursive`, "terraform");
    b.command("typecheck", `${tool} validate`, "terraform");
    b.command("build", `${tool} plan`, "terraform");
    b.check({ id: "tf:fmt", tier: "lint", label: "format", cmd: `${tool} fmt -check <files>`, argv: [tool, "fmt", "-check", "-no-color"], appendFiles: true, unscopedArgs: ["-recursive"], source: "*.tf", exts: [".tf", ".tfvars"], requires: req, tool: "terraform" });
    if (b.hasDir(".terraform")) b.check({ id: "tf:validate", tier: "fast", label: "validate", cmd: `${tool} validate`, argv: [tool, "validate", "-no-color"], source: "*.tf (.terraform initialised)", exts: [".tf", ".tfvars"], requires: req, tool: "terraform" });
    else b.note(`terraform not initialised (no .terraform/) — \`${tool} init\` is required before validate/plan`);
  }
  if (b.hasFile("Pulumi.yaml")) b.add("Pulumi");
  if (b.hasFile("serverless.yml") || b.hasFile("serverless.yaml")) b.add("Serverless Framework");
  if (b.hasFile("template.yaml") && /AWS::Serverless/.test(b.text("template.yaml") ?? "")) b.add("AWS SAM");
  if (b.hasFile("cdk.json")) b.add("AWS CDK");
  if (b.hasFile("wrangler.toml") || b.hasFile("wrangler.json") || b.hasFile("wrangler.jsonc")) b.add("Cloudflare Workers (wrangler)");
  if (b.hasFile("vercel.json")) b.add("Vercel");
  if (b.hasFile("netlify.toml")) b.add("Netlify");
  if (b.hasFile("fly.toml")) b.add("Fly.io");
  if (b.hasFile("render.yaml")) b.add("Render");
  if (b.hasFile("railway.json") || b.hasFile("railway.toml")) b.add("Railway");
  if (b.hasFile("app.yaml")) b.add("App Engine");
  if (b.hasFile("Procfile")) b.add("Procfile");
  if (b.hasFile("flake.nix")) b.add("Nix flake");
  else if (b.hasFile("shell.nix") || b.hasFile("default.nix")) b.add("Nix");
  if (b.hasFile("devbox.json")) b.add("Devbox");
  if (b.hasFile(".devcontainer/devcontainer.json") || b.hasFile(".devcontainer.json")) b.add("Dev Container");
  if (b.hasFile("Vagrantfile")) b.add("Vagrant");
  if (b.hasFile("Dockerfile") || b.hasFile("Containerfile")) b.add("Dockerfile");
  if (b.hasDir("helm") || b.hasFile("Chart.yaml")) b.add("Helm chart");
  if (b.hasDir("k8s") || b.hasDir("kubernetes") || b.hasDir("manifests")) b.add("Kubernetes manifests");
  if (b.hasFile("skaffold.yaml")) b.add("Skaffold");
  if (b.hasFile("Tiltfile")) b.add("Tilt");
  if (b.hasFile("ansible.cfg") || b.hasDir("playbooks")) b.add("Ansible");
  if (b.hasFile("supabase/config.toml")) b.add("Supabase (supabase/)");
  if (b.hasFile("firebase.json")) b.add("Firebase");
  if (b.hasFile("amplify.yml") || b.hasDir("amplify")) b.add("Amplify");
  // shell scripts: only when the repository has some (keeps the profile independent of what happens to be installed)
  const isShell = (f: string) => /\.(sh|bash)$/.test(f);
  const shellFiles = (b.extCounts[".sh"] ?? 0) + (b.extCounts[".bash"] ?? 0) + b.rootFiles(/\.(sh|bash)$/).length + ["scripts", "script", "bin", "tools"].reduce((n, d) => n + b.files(d).filter(isShell).length, 0);
  if (shellFiles > 0 && b.which("bash")) b.check({ id: "sh:syntax", tier: "syntax", label: "syntax", cmd: "bash -n <file>", argv: ["bash", "-n"], appendFiles: true, source: "bash", exts: [".sh", ".bash"], requires: { bin: "bash" }, tool: "bash" });
  if (shellFiles > 0 && b.which("shellcheck")) b.check({ id: "sh:shellcheck", tier: "lint", label: "lint", cmd: "shellcheck <files>", argv: ["shellcheck", "--format=gcc"], appendFiles: true, source: "shellcheck on PATH", exts: [".sh", ".bash"], requires: { bin: "shellcheck" }, tool: "shellcheck", incidental: true });
  if (b.which("hadolint") && (b.hasFile("Dockerfile") || b.hasFile(".hadolint.yaml"))) b.check({ id: "docker:hadolint", tier: "lint", label: "lint", cmd: "hadolint <files>", argv: ["hadolint", "--no-color"], appendFiles: true, source: "hadolint on PATH", exts: [".dockerfile"], requires: { bin: "hadolint" }, tool: "hadolint", incidental: true });
  // Lua
  if (b.rootFiles(/\.rockspec$/).length || b.hasFile(".luarc.json") || b.hasFile("init.lua") && b.hasDir("lua")) {
    b.lang("Lua");
    if (b.which("luacheck")) b.check({ id: "lua:luacheck", tier: "lint", label: "lint", cmd: "luacheck <files>", argv: ["luacheck", "--no-color", "--formatter", "plain"], appendFiles: true, unscopedArgs: ["."], source: "luacheck on PATH", exts: [".lua"], requires: { bin: "luacheck" }, tool: "luacheck" });
    if (b.which("luac")) b.check({ id: "lua:syntax", tier: "syntax", label: "syntax", cmd: "luac -p <files>", argv: ["luac", "-p"], appendFiles: true, source: "luac", exts: [".lua"], requires: { bin: "luac" }, tool: "lua" });
    if (b.hasFile(".stylua.toml") || b.hasFile("stylua.toml")) b.convention("StyLua");
    if (b.hasFile(".busted")) b.command("test", "busted", ".busted");
  }
  // Perl
  if (b.hasFile("cpanfile") || b.hasFile("Makefile.PL") || b.hasFile("dist.ini")) {
    b.lang("Perl");
    b.command("test", "prove -l t", "perl");
    if (b.which("perl")) b.check({ id: "perl:syntax", tier: "syntax", label: "syntax", cmd: "perl -c <file>", argv: ["perl", "-c"], appendFiles: true, source: "perl", exts: [".pl", ".pm"], requires: { bin: "perl" }, tool: "perl" });
  }
}
