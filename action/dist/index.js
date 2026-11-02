// action/src/main.ts
import { execFileSync as execFileSync3 } from "child_process";
import fs2 from "fs";

// src/notes.ts
import { execFileSync as execFileSync2 } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// src/git.ts
import { execFileSync } from "child_process";
function git(cwd, args) {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// src/notes.ts
var NOTES_REF = "refs/notes/rcpt";
function notesRefs(root) {
  const remotes = git(root, ["for-each-ref", "--format=%(refname)", "refs/notes/remotes/"]).split("\n").filter((r) => r.endsWith("/rcpt"));
  const hasLocal = git(root, ["for-each-ref", "--format=%(refname)", NOTES_REF]).trim() !== "";
  return [...hasLocal ? [NOTES_REF] : [], ...remotes];
}
function isReceipt(v) {
  return typeof v === "object" && v !== null && typeof v.schemaVersion === "number" && typeof v.commitSha === "string";
}
function readAllReceipts(root) {
  const blobByCommit = /* @__PURE__ */ new Map();
  for (const ref of notesRefs(root)) {
    for (const line of git(root, ["notes", `--ref=${ref}`, "list"]).split("\n")) {
      const [blob, commit] = line.split(" ");
      if (blob && commit && !blobByCommit.has(commit)) blobByCommit.set(commit, blob);
    }
  }
  const out = /* @__PURE__ */ new Map();
  if (!blobByCommit.size) return out;
  const commits = [...blobByCommit.keys()];
  const batch = execFileSync2("git", ["cat-file", "--batch"], {
    cwd: root,
    input: commits.map((c) => blobByCommit.get(c)).join("\n") + "\n",
    maxBuffer: 1024 * 1024 * 1024
  });
  let pos = 0;
  for (const commit of commits) {
    const nl = batch.indexOf(10, pos);
    const header = batch.subarray(pos, nl).toString();
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    const body = batch.subarray(nl + 1, nl + 1 + size).toString("utf8");
    pos = nl + 1 + size + 1;
    try {
      const v = JSON.parse(body);
      if (isReceipt(v)) out.set(commit, v);
    } catch {
    }
  }
  return out;
}

// src/pr-summary.ts
var COMMENT_MARKER = "<!-- rcpt:pr-summary -->";
var usd = (n) => n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
var mdEscape = (s) => s.replace(/[\\`*_[\]<>|]/g, "\\$&");
function summarizePr(commits, receipts) {
  const rows = commits.map((c) => ({ ...c, r: receipts.get(c.sha) ?? null }));
  const withReceipt = rows.filter((x) => x.r && !x.r.isMerge);
  const ai = withReceipt.filter((x) => x.r.aiAssisted);
  const agents = [...new Set(ai.flatMap((x) => x.r.sessions.filter((s) => s.confidence !== "low").map((s) => s.agent)))].sort();
  let aiLines = 0;
  let known = 0;
  for (const x of withReceipt) {
    aiLines += x.r.totals.aiLinesAdded;
    known += x.r.totals.totalLinesAdded - x.r.totals.unknownLines;
  }
  const aiShare = known ? aiLines / known : null;
  const statuses = ai.map((x) => x.r.testsRun.status);
  const tests = !ai.length || statuses.every((s) => s === "none") ? "none" : statuses.includes("failed") ? "failed" : statuses.every((s) => s === "passed") ? "passed" : "partial";
  const costs = ai.map((x) => x.r.estimatedCostUsd.amount);
  const costUsd = costs.some((c) => c !== null) ? costs.reduce((a, c) => a + (c ?? 0), 0) : null;
  const costPartial = costUsd !== null && costs.some((c) => c === null);
  const parts = [`\u{1F9FE} rcpt: ${ai.length} of ${rows.length} commit${rows.length === 1 ? "" : "s"} AI-assisted`];
  if (agents.length) parts.push(agents.join(", "));
  if (aiShare !== null) parts.push(`${Math.round(aiShare * 100)}% of added lines`);
  if (ai.length) parts.push(`tests ${{ passed: "\u2705", failed: "\u274C", partial: "\u26A0\uFE0F", none: "\u2014" }[tests]}`);
  if (costUsd !== null) parts.push(`est. ${usd(costUsd)}${costPartial ? "+" : ""}`);
  const missing = rows.length - withReceipt.length - rows.filter((x) => x.r?.isMerge).length;
  if (missing) parts.push(`${missing} without receipt`);
  const headline = parts.join(" \xB7 ");
  const table = rows.map((x) => {
    const short = `\`${x.sha.slice(0, 7)}\``;
    const subj = mdEscape(x.subject.length > 60 ? x.subject.slice(0, 59) + "\u2026" : x.subject);
    const r = x.r;
    if (!r) return `| ${short} | ${subj} | no receipt | | | |`;
    if (r.isMerge) return `| ${short} | ${subj} | merge | | | |`;
    const who = r.aiAssisted ? r.sessions.filter((s) => s.confidence !== "low").map((s) => `${s.agent}/${s.models[0] ?? "?"}`).join(", ") : "human";
    const lines = `${r.totals.unknownLines ? "?" : r.totals.aiLinesAdded} / ${r.totals.totalLinesAdded}`;
    const t = { passed: "\u2705", failed: "\u274C", unknown: "\u2754", none: "\u2014" }[r.testsRun.status];
    const cost = r.aiAssisted && r.estimatedCostUsd.amount !== null ? usd(r.estimatedCostUsd.amount) : "\u2014";
    return `| ${short} | ${subj} | ${mdEscape(who)}${r.confidence && r.aiAssisted ? ` (${r.confidence})` : ""} | ${lines} | ${t} | ${cost} |`;
  }).join("\n");
  const body = [
    COMMENT_MARKER,
    `**${headline}**`,
    "",
    "<details><summary>Per-commit receipts</summary>",
    "",
    "| Commit | Subject | Author | AI / added lines | Tests | Est. cost |",
    "|---|---|---|---|---|---|",
    table,
    "",
    "Commits without a receipt are not assumed to be human-written. Line shares exclude lines an agent may have written through shell commands. Costs are estimates at public list prices. See `rcpt receipt <sha>` for details.",
    "</details>"
  ].join("\n");
  return { headline, body, stats: { commits: rows.length, withReceipt: withReceipt.length, aiAssisted: ai.length, aiShare, costUsd, tests } };
}

// action/src/main.ts
var input = (name, fallback = "") => process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`]?.trim() || fallback;
var api = process.env.GITHUB_API_URL || "https://api.github.com";
function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs2.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<__RCPT__
${value}
__RCPT__
`);
}
async function gh(token, method, path2, body) {
  const res = await fetch(path2.startsWith("http") ? path2 : `${api}${path2}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body)
  });
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, data, next };
}
async function all(token, path2) {
  const out = [];
  for (let url = `${path2}${path2.includes("?") ? "&" : "?"}per_page=100`; url; ) {
    const r = await gh(token, "GET", url);
    if (r.status >= 400) throw new Error(`GET ${url} failed: HTTP ${r.status}`);
    out.push(...r.data);
    url = r.next;
  }
  return out;
}
async function run() {
  const token = input("github-token");
  const repo = process.env.GITHUB_REPOSITORY;
  const event = JSON.parse(fs2.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request?.number ?? event.number;
  if (!pr) {
    console.log("rcpt: not a pull_request event; nothing to do.");
    return;
  }
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const remote = input("remote", "origin");
  try {
    execFileSync3("git", ["fetch", "--no-tags", "--quiet", remote, `+refs/notes/rcpt*:refs/notes/remotes/${remote}/rcpt*`], { cwd, stdio: "inherit" });
  } catch {
    console.log('::warning::rcpt: could not fetch refs/notes/rcpt; every commit will show "no receipt".');
  }
  const receipts = readAllReceipts(cwd);
  const commits = (await all(token, `/repos/${repo}/pulls/${pr}/commits`)).map(
    (c) => ({ sha: c.sha, subject: c.commit.message.split("\n")[0] ?? "" })
  );
  const summary = summarizePr(commits, receipts);
  console.log(summary.headline);
  setOutput("summary", summary.headline);
  setOutput("ai-assisted-commits", String(summary.stats.aiAssisted));
  setOutput("ai-share", summary.stats.aiShare === null ? "" : summary.stats.aiShare.toFixed(4));
  if (process.env.GITHUB_STEP_SUMMARY) fs2.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.body + "\n");
  if (input("comment", "true") !== "true") return;
  const existing = (await all(token, `/repos/${repo}/issues/${pr}/comments`)).find(
    (c) => c.body?.includes(COMMENT_MARKER)
  );
  const res = existing ? await gh(token, "PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body: summary.body }) : await gh(token, "POST", `/repos/${repo}/issues/${pr}/comments`, { body: summary.body });
  if (res.status === 403 || res.status === 404) {
    console.log(`::warning::rcpt: no permission to comment on this PR (HTTP ${res.status}); see the job summary instead.`);
  } else if (res.status >= 400) {
    throw new Error(`commenting failed: HTTP ${res.status}`);
  } else {
    console.log(existing ? `rcpt: updated comment ${existing.id}` : "rcpt: posted comment");
  }
}
run().catch((err) => {
  console.log(`::error::rcpt: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
