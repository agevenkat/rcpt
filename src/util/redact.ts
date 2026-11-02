// Redaction runs on every prompt and command before it enters an AgentSession.
// Patterns favor catching secrets over preserving text; false positives are acceptable.

const RULES: [label: string, re: RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi],
  ['url-credentials', /(?<=\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
];

// KEY=value / KEY: value where the key name suggests a secret (.env style, YAML, CLI flags).
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_.-]*)(\s*[:=]\s*|\s+)(["']?)([^\s"']{4,})\3/gi;

export function redact(text: string): string {
  let out = text;
  for (const [label, re] of RULES) out = out.replace(re, `[REDACTED:${label}]`);
  out = out.replace(SECRET_ASSIGNMENT, (m, key: string, sep: string, q: string, val: string) =>
    val.startsWith('[REDACTED:') ? m : `${key}${sep}${q}[REDACTED:secret]${q}`,
  );
  return out;
}
