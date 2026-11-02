// Recognize test-runner invocations. Users can extend this via config in a later phase.

export const DEFAULT_TEST_PATTERNS: RegExp[] = [
  /^(npm|pnpm|yarn|bun)( run)? test\b/,
  /^(npm|pnpm|yarn|bun) run test[:\w-]*/,
  /^bun test\b/,
  /^(npx |pnpm exec |pnpm dlx |yarn |bunx )?(vitest|jest|mocha|ava|playwright test|cypress run)\b/,
  /^(python3? -m )?pytest\b/,
  /^python3? -m unittest\b/,
  /^(tox|nox)\b/,
  /^go test\b/,
  /^cargo (test|nextest)\b/,
  /^(mvn|\.\/mvnw)\b.*\b(test|verify)\b/,
  /^(gradle|\.\/gradlew)\b.*\btest\b/,
  /^(bundle exec )?(rspec|rake test)\b/,
  /^(vendor\/bin\/)?phpunit\b/,
  /^dotnet test\b/,
  /^deno test\b/,
  /^swift test\b/,
  /^make (test|check)\b/,
];

/** Split a shell line into simple commands and strip env assignments / cd prefixes. */
function segments(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\|/)
    .map((s) =>
      s
        .trim()
        .replace(/^(\w+=\S*\s+)+/, '')
        .replace(/^(time|exec)\s+/, '')
        // Windows: npm.cmd test, pytest.exe, .\gradlew.bat test
        .replace(/^(\.[\\/])?([\w.-]+)\.(cmd|exe|bat|ps1)\b/i, (_m, dot: string | undefined, name: string) => `${dot ? './' : ''}${name}`),
    )
    .filter(Boolean);
}

export function isTestCommand(cmd: string, extra: RegExp[] = []): boolean {
  const patterns = [...DEFAULT_TEST_PATTERNS, ...extra];
  return segments(cmd).some((s) => patterns.some((p) => p.test(s)));
}
