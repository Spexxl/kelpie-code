import type { Builder } from "./context.ts";
import { parseToolVersions } from "./context.ts";

const MODULES: Array<[string, string]> = [
  ["github.com/gin-gonic/gin", "Gin"],
  ["github.com/labstack/echo", "Echo"],
  ["github.com/gofiber/fiber", "Fiber"],
  ["github.com/go-chi/chi", "chi"],
  ["github.com/gorilla/mux", "gorilla/mux"],
  ["github.com/spf13/cobra", "Cobra"],
  ["github.com/urfave/cli", "urfave/cli"],
  ["github.com/spf13/viper", "Viper"],
  ["google.golang.org/grpc", "gRPC"],
  ["github.com/grpc-ecosystem", "grpc-gateway"],
  ["connectrpc.com/connect", "Connect"],
  ["gorm.io/gorm", "GORM"],
  ["github.com/jackc/pgx", "pgx"],
  ["entgo.io/ent", "Ent"],
  ["github.com/uber-go/zap", "zap"],
  ["go.uber.org/zap", "zap"],
  ["github.com/rs/zerolog", "zerolog"],
  ["github.com/stretchr/testify", "testify"],
  ["github.com/onsi/ginkgo", "Ginkgo"],
  ["k8s.io/client-go", "client-go (Kubernetes)"],
  ["sigs.k8s.io/controller-runtime", "controller-runtime"],
  ["github.com/hashicorp/terraform-plugin", "Terraform plugin"],
  ["github.com/charmbracelet/bubbletea", "Bubble Tea"],
  ["github.com/wailsapp/wails", "Wails"],
  ["fyne.io/fyne", "Fyne"],
  ["github.com/aws/aws-sdk-go", "AWS SDK"],
  ["cloud.google.com/go", "Google Cloud SDK"],
  ["github.com/temporalio/sdk-go", "Temporal"],
];

export function detectGo(b: Builder): void {
  if (!b.hasFile("go.mod")) return;
  const mod = b.text("go.mod") ?? "";
  b.lang("Go");
  const module = mod.match(/^module\s+(\S+)/m)?.[1];
  const goVersion = mod.match(/^go\s+(\S+)/m)?.[1];
  const toolVersions = parseToolVersions(b.text(".tool-versions"));
  b.runtime("go", toolVersions["golang"] ?? toolVersions["go"] ?? goVersion);
  if (module) b.add(`module ${module}`);
  if (b.hasFile("go.work")) {
    b.add("go workspace (go.work)");
    b.monorepo = { kind: "go workspace" };
  }
  for (const [m, label] of MODULES) if (mod.includes(m)) b.add(label);
  if (b.hasFile(".golangci.yml") || b.hasFile(".golangci.yaml") || b.hasFile(".golangci.toml") || b.hasFile(".golangci.json")) b.convention("golangci-lint");
  if (b.hasFile("Dockerfile")) b.add("Dockerfile");
  if (b.hasDir("cmd")) b.note("cmd/ layout (multiple binaries)");

  const requires = { bin: "go", hint: "go not found on PATH" };
  if (!b.which("go")) b.note("go not on PATH — Go checks skipped");
  b.command("install", "go mod download", "go");
  b.command("typecheck", "go build ./... && go vet ./...", "go");
  b.command("lint", b.conventions.includes("golangci-lint") ? "golangci-lint run" : "gofmt -l . && go vet ./...", "go");
  b.command("format", "gofmt -w .", "go");
  b.command("test", "go test ./...", "go");
  b.command("test:one", "go test ./<pkg> -run '^<TestName>$'", "go");
  b.command("build", "go build ./...", "go");
  if (b.hasFile("main.go")) b.command("run", "go run .", "go");

  b.check({ id: "go:build", tier: "fast", label: "typecheck", cmd: "go build ./...", argv: ["go", "build", "./..."], source: "go.mod", exts: [".go", ".mod", ".sum"], requires, tool: "go", env: { GOFLAGS: "-mod=readonly" } });
  b.check({ id: "go:vet", tier: "fast", label: "vet", cmd: "go vet ./...", argv: ["go", "vet", "./..."], source: "go.mod", exts: [".go"], requires, tool: "go", env: { GOFLAGS: "-mod=readonly" } });
  b.check({ id: "go:fmt", tier: "lint", label: "format", cmd: "gofmt -l <files>", argv: ["gofmt", "-l"], appendFiles: true, unscopedArgs: ["."], failOnOutput: true, source: "gofmt", exts: [".go"], requires: { bin: "gofmt", hint: "gofmt not found on PATH" }, tool: "gofmt" });
  if (b.conventions.includes("golangci-lint") && b.which("golangci-lint")) {
    b.check({ id: "go:golangci", tier: "lint", label: "lint", cmd: "golangci-lint run", argv: ["golangci-lint", "run", "--color", "never"], source: ".golangci config", exts: [".go"], requires: { bin: "golangci-lint" }, tool: "golangci" });
  } else if (b.which("staticcheck")) {
    b.check({ id: "go:staticcheck", tier: "lint", label: "lint", cmd: "staticcheck ./...", argv: ["staticcheck", "./..."], source: "staticcheck on PATH", exts: [".go"], requires: { bin: "staticcheck" }, tool: "go" });
  }
  b.check({ id: "go:test", tier: "test", label: "test", cmd: "go test ./...", argv: ["go", "test", "./..."], source: "go.mod", exts: [".go", ".mod", ".sum"], requires, tool: "go", env: { GOFLAGS: "-mod=readonly" }, scope: { kind: "go" } });
}
