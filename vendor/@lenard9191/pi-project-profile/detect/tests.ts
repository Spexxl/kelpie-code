/**
 * Test conventions from the tracked file list: which naming pattern the
 * project uses and where tests live, so the agent writes new tests in the
 * right place and style instead of inventing a layout.
 */

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/\.(test|spec)\.([cm]?[jt]sx?)$/, (m) => `*.${m[1]}.${m[2]}`],
  [/(^|\/)test_[^/]+\.py$/, () => "test_*.py"],
  [/_test\.py$/, () => "*_test.py"],
  [/_test\.go$/, () => "*_test.go"],
  [/(^|\/)tests\/[^/]+\.rs$/, () => "tests/*.rs"],
  [/_spec\.rb$/, () => "*_spec.rb"],
  [/_test\.rb$/, () => "*_test.rb"],
  [/Tests?\.(java|kt|cs|swift)$/, (m) => `*Test.${m[1]}`],
  [/Test\.php$/, () => "*Test.php"],
  [/_test\.exs$/, () => "*_test.exs"],
  [/_test\.dart$/, () => "*_test.dart"],
  [/(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/, () => "__tests__/*"],
];

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs|src\/test)\//;

/** One line such as: "`*.test.ts` next to source (42) · `test_*.py` in tests/ (12)". */
export function testConventions(files: string[]): string | undefined {
  const byPattern = new Map<string, { count: number; inDir: Map<string, number> }>();
  for (const f of files) {
    if (!f || f.includes("node_modules/") || f.startsWith("vendor/")) continue;
    for (const [re, name] of PATTERNS) {
      const m = f.match(re);
      if (!m) continue;
      const key = name(m);
      const entry = byPattern.get(key) ?? { count: 0, inDir: new Map() };
      entry.count++;
      const dir = f.match(TEST_DIR);
      // Group "packages/x/tests/" and "tests/" alike by the test directory's own name.
      const label = dir ? `${dir[2]}/` : "";
      entry.inDir.set(label, (entry.inDir.get(label) ?? 0) + 1);
      byPattern.set(key, entry);
      break;
    }
  }
  const ranked = Array.from(byPattern.entries())
    .filter(([, e]) => e.count >= 2)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 2);
  if (ranked.length === 0) return undefined;
  return ranked
    .map(([pattern, e]) => {
      const inDirs = Array.from(e.inDir.entries()).filter(([d]) => d !== "");
      const dirCount = inDirs.reduce((n, [, c]) => n + c, 0);
      if (dirCount / e.count >= 0.6) {
        const top = inDirs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
        return pattern.startsWith(top) ? `\`${pattern}\` (${e.count})` : `\`${pattern}\` in ${top} (${e.count})`;
      }
      return `\`${pattern}\` next to source (${e.count})`;
    })
    .join(" · ");
}
