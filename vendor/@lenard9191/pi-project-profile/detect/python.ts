import { join } from "node:path";
import { executableCandidates, isExecutable, isWindows } from "../fs-utils.ts";
import { PY_PREFIX, type ScopeSpec } from "../types.ts";
import { pythonDisplay } from "../verify/resolve.ts";
import type { Builder } from "./context.ts";
import { parseToolVersions, tomlHasTable, tomlSections } from "./context.ts";

const PKGS: Array<[RegExp, string]> = [
  [/^django\b/i, "Django"],
  [/^flask\b/i, "Flask"],
  [/^fastapi\b/i, "FastAPI"],
  [/^starlette\b/i, "Starlette"],
  [/^litestar\b/i, "Litestar"],
  [/^tornado\b/i, "Tornado"],
  [/^aiohttp\b/i, "aiohttp"],
  [/^httpx\b/i, "httpx"],
  [/^requests\b/i, "requests"],
  [/^pydantic\b/i, "Pydantic"],
  [/^sqlalchemy\b/i, "SQLAlchemy"],
  [/^alembic\b/i, "Alembic"],
  [/^celery\b/i, "Celery"],
  [/^typer\b/i, "Typer"],
  [/^click\b/i, "Click"],
  [/^numpy\b/i, "NumPy"],
  [/^pandas\b/i, "pandas"],
  [/^polars\b/i, "Polars"],
  [/^torch\b/i, "PyTorch"],
  [/^tensorflow\b/i, "TensorFlow"],
  [/^jax\b/i, "JAX"],
  [/^scikit-learn\b/i, "scikit-learn"],
  [/^transformers\b/i, "Transformers"],
  [/^langchain\b/i, "LangChain"],
  [/^openai\b/i, "openai SDK"],
  [/^anthropic\b/i, "anthropic SDK"],
  [/^streamlit\b/i, "Streamlit"],
  [/^gradio\b/i, "Gradio"],
  [/^scrapy\b/i, "Scrapy"],
  [/^boto3\b/i, "boto3"],
  [/^pyspark\b/i, "PySpark"],
  [/^airflow\b|^apache-airflow\b/i, "Airflow"],
  [/^pytest\b/i, "pytest"],
  [/^hypothesis\b/i, "Hypothesis"],
  [/^mypy\b/i, "mypy"],
  [/^pyright\b/i, "pyright"],
  [/^ruff\b/i, "Ruff"],
  [/^black\b/i, "Black"],
  [/^isort\b/i, "isort"],
  [/^flake8\b/i, "flake8"],
  [/^pylint\b/i, "pylint"],
  [/^maturin\b/i, "maturin (Rust ext)"],
  [/^setuptools-rust\b/i, "setuptools-rust"],
  [/^cython\b/i, "Cython"],
];

/**
 * Dependency names from pyproject.toml: PEP 621 arrays (`dependencies = [...]`,
 * `[project.optional-dependencies]`, `[dependency-groups]`) and Poetry/PDM tables.
 */
export function pyprojectDeps(text: string | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const req = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([<>=!~;@ ].*)?$/;
  // arrays: key = [ "a", "b>=1" ] possibly multi-line, inside dependency-ish contexts
  let section = "";
  const lines = text.split("\n");
  let inArray = false;
  let arrayIsDeps = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sec = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (sec) {
      section = sec[1]!.trim();
      inArray = false;
      continue;
    }
    const depSection = /dependenc|dependency-groups|\.dev$/.test(section);
    if (!inArray) {
      const kv = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.*)$/);
      if (kv) {
        const key = kv[1]!.replace(/"/g, "");
        const val = kv[2]!;
        if (val.startsWith("[")) {
          arrayIsDeps = depSection || /dependenc/.test(key) || section === "dependency-groups";
          inArray = !val.includes("]");
          if (arrayIsDeps) for (const s of val.matchAll(/"([^"]+)"|'([^']+)'/g)) addReq(s[1] ?? s[2]!);
          continue;
        }
        if (depSection && /^tool\.(poetry|pdm)/.test(section) && key !== "python") out.add(key.toLowerCase());
        continue;
      }
    } else {
      if (arrayIsDeps) for (const s of line.matchAll(/"([^"]+)"|'([^']+)'/g)) addReq(s[1] ?? s[2]!);
      if (line.includes("]")) inArray = false;
    }
  }
  function addReq(s: string) {
    const m = s.trim().match(req);
    if (m) out.add(m[1]!.toLowerCase());
  }
  return Array.from(out);
}

export function detectPython(b: Builder): void {
  const pyproject = b.hasFile("pyproject.toml") ? b.text("pyproject.toml") : undefined;
  const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "requirements-dev.txt", "Pipfile", "tox.ini", "noxfile.py", "manage.py", "environment.yml", "poetry.lock", "uv.lock", "pdm.lock"];
  const present = markers.filter((m) => b.hasFile(m));
  if (present.length === 0) {
    // a bare python project: any *.py at root + tests dir?
    const rootPy = b.rootFiles(/\.py$/);
    if (rootPy.length === 0) return;
  }
  b.lang("Python");

  // --- dependency names from any source ---
  const depText = [
    pyproject ?? "",
    b.text("requirements.txt") ?? "",
    b.text("requirements-dev.txt") ?? "",
    b.text("requirements/dev.txt") ?? "",
    b.text("setup.cfg") ?? "",
    b.text("setup.py") ?? "",
    b.text("Pipfile") ?? "",
    b.text("environment.yml") ?? "",
  ].join("\n");
  const depNames = new Set<string>();
  for (const line of depText.split("\n")) {
    const m = line.trim().replace(/^["'-]+\s*/, "").match(/^([A-Za-z0-9_.-]+)\s*(\[.*?\])?\s*([<>=!~;].*)?$/);
    if (m) depNames.add(m[1]!.toLowerCase());
  }
  for (const d of pyprojectDeps(pyproject)) depNames.add(d);
  const hasDep = (re: RegExp) => Array.from(depNames).some((d) => re.test(d));
  for (const [re, label] of PKGS) if (hasDep(re)) b.add(label);

  // --- runtime / manager ---
  const toolVersions = parseToolVersions(b.text(".tool-versions"));
  const requiresPython = tomlSections(pyproject).get("project")?.["requires-python"] ?? tomlSections(pyproject).get("tool.poetry.dependencies")?.["python"];
  b.runtime("python", b.text(".python-version")?.trim().split("\n")[0] ?? toolVersions["python"] ?? requiresPython);

  let runner: string[] = [];
  let runnerLabel = "";
  let manager = "pip";
  if (b.hasFile("uv.lock") || tomlHasTable(pyproject, "tool.uv")) {
    manager = "uv";
    runner = ["uv", "run", "--"];
    runnerLabel = "uv run";
  } else if (b.hasFile("poetry.lock") || tomlHasTable(pyproject, "tool.poetry")) {
    manager = "poetry";
    runner = ["poetry", "run"];
    runnerLabel = "poetry run";
  } else if (b.hasFile("pdm.lock") || tomlHasTable(pyproject, "tool.pdm")) {
    manager = "pdm";
    runner = ["pdm", "run"];
    runnerLabel = "pdm run";
  } else if (b.hasFile("Pipfile")) {
    manager = "pipenv";
    runner = ["pipenv", "run"];
    runnerLabel = "pipenv run";
  } else if (tomlHasTable(pyproject, "tool.hatch")) {
    manager = "hatch";
    runner = ["hatch", "run"];
    runnerLabel = "hatch run";
  } else if (b.hasFile("environment.yml")) {
    manager = "conda";
  }
  const venvDir = [".venv", "venv", "env", ".env"].find((d) => executableCandidates("python").some((n) => isExecutable(join(b.root, d, isWindows() ? "Scripts" : "bin", n))));
  b.add(manager + (venvDir && manager === "pip" ? ` (${venvDir})` : ""));
  if (b.hasFile("tox.ini")) b.add("tox");
  if (b.hasFile("noxfile.py")) b.add("nox");
  if (b.hasFile("manage.py")) b.add("Django project (manage.py)");
  if (b.hasFile(".pre-commit-config.yaml")) b.convention("pre-commit hooks");
  if (b.hasFile("alembic.ini")) b.add("Alembic migrations");

  // --- tool invocation is resolved at run time (runner → venv → PATH), see verify/resolve.ts ---
  const toolArgv = (tool: string): { argv: string[]; cmd: string } => ({ argv: [`${PY_PREFIX}${manager}:${tool}`], cmd: pythonDisplay(manager, tool) });
  const pythonArgv = (): { argv: string[]; cmd: string } => ({ argv: [`${PY_PREFIX}${manager}:python`], cmd: pythonDisplay(manager, "python") });
  b.fingerprintFiles.add(".venv");
  b.fingerprintFiles.add("venv");

  // --- config-driven tools ---
  const setupCfg = b.text("setup.cfg") ?? "";
  const hasRuff = tomlHasTable(pyproject, "tool.ruff") || b.hasFile("ruff.toml") || b.hasFile(".ruff.toml") || depNames.has("ruff");
  const hasMypy = tomlHasTable(pyproject, "tool.mypy") || b.hasFile("mypy.ini") || b.hasFile(".mypy.ini") || /^\[mypy\]/m.test(setupCfg) || depNames.has("mypy");
  const hasPyright = tomlHasTable(pyproject, "tool.pyright") || b.hasFile("pyrightconfig.json") || depNames.has("pyright");
  const hasFlake8 = b.hasFile(".flake8") || /^\[flake8\]/m.test(setupCfg) || b.hasFile("tox.ini") && /^\[flake8\]/m.test(b.text("tox.ini") ?? "");
  const hasBlack = tomlHasTable(pyproject, "tool.black") || depNames.has("black");
  const hasIsort = tomlHasTable(pyproject, "tool.isort") || b.hasFile(".isort.cfg") || depNames.has("isort");
  const hasPylint = tomlHasTable(pyproject, "tool.pylint") || b.hasFile(".pylintrc") || b.hasFile("pylintrc");
  const testsDir = ["tests", "test", "spec"].find((d) => b.hasDir(d));
  const hasPytest = tomlHasTable(pyproject, "tool.pytest") || b.hasFile("pytest.ini") || b.hasFile("conftest.py") || depNames.has("pytest") || /^\[tool:pytest\]/m.test(setupCfg) || (testsDir !== undefined && b.hasFile(join(testsDir, "conftest.py")));
  if (hasRuff) b.convention("Ruff");
  if (hasBlack) b.convention("Black");
  if (hasIsort) b.convention("isort");
  if (hasFlake8) b.convention("flake8");
  if (hasMypy) b.convention("mypy");
  if (hasPyright) b.convention("pyright");

  // --- commands (display) ---
  const installCmd = manager === "uv" ? "uv sync" : manager === "poetry" ? "poetry install" : manager === "pdm" ? "pdm install" : manager === "pipenv" ? "pipenv install --dev" : manager === "conda" ? "conda env create -f environment.yml" : b.hasFile("requirements-dev.txt") ? "pip install -r requirements-dev.txt" : b.hasFile("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .";
  b.command("install", installCmd, manager);
  const prefix = runnerLabel ? `${runnerLabel} ` : "";
  if (hasMypy) b.command("typecheck", `${prefix}mypy .`, "mypy config");
  else if (hasPyright) b.command("typecheck", `${prefix}pyright`, "pyright config");
  if (hasRuff) b.command("lint", `${prefix}ruff check .`, "ruff config");
  else if (hasFlake8) b.command("lint", `${prefix}flake8`, "flake8 config");
  else if (hasPylint) b.command("lint", `${prefix}pylint .`, "pylint config");
  if (hasRuff) b.command("format", `${prefix}ruff format .`, "ruff");
  else if (hasBlack) b.command("format", `${prefix}black .`, "black");
  if (hasPytest) b.command("test", `${prefix}pytest`, "pytest");
  else if (b.hasFile("manage.py")) b.command("test", `${prefix}python manage.py test`, "Django");
  else if (b.hasFile("tox.ini")) b.command("test", "tox", "tox.ini");
  else if (testsDir) b.command("test", `${prefix}python -m unittest discover ${testsDir}`, "unittest");
  if (hasPytest) b.command("test:one", `${prefix}pytest <file>::<test_name>`, "pytest");
  else if (b.hasFile("manage.py")) b.command("test:one", `${prefix}python manage.py test <app.tests.TestClass.test_method>`, "Django");
  else if (testsDir) b.command("test:one", `${prefix}python -m unittest <module.TestClass.test_method>`, "unittest");
  if (b.hasFile("manage.py")) b.command("dev", `${prefix}python manage.py runserver`, "Django");
  const scripts = tomlSections(pyproject).get("tool.pdm.scripts") ?? tomlSections(pyproject).get("tool.poe.tasks");
  if (scripts) for (const k of Object.keys(scripts)) b.note(`task: ${k}`);

  // --- checks ---
  const pyExts = [".py", ".pyi", ".toml", ".cfg", ".ini"];
  const missingHint = (tool: string) => `${tool} not available — run \`${installCmd}\` or install it in the active environment`;
  const addTool = (id: string, tier: "fast" | "lint" | "test", label: string, tool: string, args: string[], opts: { appendFiles?: boolean; unscopedArgs?: string[]; exts?: string[]; toolFamily?: string; source: string; env?: Record<string, string>; scope?: ScopeSpec }) => {
    const t = toolArgv(tool);
    b.check({ id, tier, label, cmd: `${t.cmd} ${args.join(" ")}${opts.appendFiles ? " <files>" : ""}`.replace(/\s+/g, " ").trim(), argv: [...t.argv, ...args], appendFiles: opts.appendFiles, unscopedArgs: opts.unscopedArgs, source: opts.source, exts: opts.exts ?? pyExts, requires: { hint: missingHint(tool) }, tool: opts.toolFamily ?? tool, env: opts.env, scope: opts.scope });
  };
  const py = pythonArgv();
  b.check({ id: "py:syntax", tier: "syntax", label: "syntax", cmd: `${py.cmd} -c "ast.parse" <files>`, argv: [...py.argv, "-c", "import ast,sys\nfor f in sys.argv[1:]:\n    ast.parse(open(f,'rb').read(), f)"], appendFiles: true, source: "python ast", exts: [".py"], requires: { hint: "python interpreter not found" }, tool: "python", env: { PYTHONDONTWRITEBYTECODE: "1" } });
  if (hasMypy) addTool("py:mypy", "fast", "typecheck", "mypy", ["--no-error-summary", "--no-color-output"], { appendFiles: true, unscopedArgs: ["."], exts: [".py", ".pyi"], source: "mypy config", toolFamily: "mypy" });
  if (hasPyright) addTool("py:pyright", "fast", "typecheck", "pyright", [], { appendFiles: true, unscopedArgs: [], exts: [".py", ".pyi"], source: "pyright config", toolFamily: "pyright" });
  if (hasRuff) {
    addTool("py:ruff", "lint", "lint", "ruff", ["check", "--no-fix", "--output-format", "concise"], { appendFiles: true, unscopedArgs: [], exts: [".py", ".pyi"], source: "ruff config", toolFamily: "ruff" });
    addTool("py:ruff-format", "lint", "format", "ruff", ["format", "--check", "--diff"], { appendFiles: true, unscopedArgs: [], exts: [".py", ".pyi"], source: "ruff config", toolFamily: "ruff" });
  } else if (hasFlake8) addTool("py:flake8", "lint", "lint", "flake8", [], { appendFiles: true, unscopedArgs: [], exts: [".py"], source: "flake8 config", toolFamily: "flake8" });
  if (!hasRuff && hasBlack) addTool("py:black", "lint", "format", "black", ["--check", "--diff", "--quiet"], { appendFiles: true, unscopedArgs: ["."], exts: [".py"], source: "black config", toolFamily: "black" });
  if (!hasRuff && hasIsort) addTool("py:isort", "lint", "imports", "isort", ["--check-only", "--diff"], { appendFiles: true, unscopedArgs: ["."], exts: [".py"], source: "isort config", toolFamily: "isort" });
  if (hasPytest) addTool("py:pytest", "test", "test", "pytest", ["-q", "-x", "-p", "no:cacheprovider", "--color=no"], { source: "pytest", toolFamily: "pytest", env: { PYTHONDONTWRITEBYTECODE: "1" }, scope: { kind: "pytest" } });
  else if (b.hasFile("manage.py")) b.check({ id: "py:django-test", tier: "test", label: "test", cmd: `${py.cmd} manage.py test`, argv: [...py.argv, "manage.py", "test", "--noinput"], source: "Django", exts: pyExts, requires: { hint: "python interpreter not found" }, tool: "django" });
}
