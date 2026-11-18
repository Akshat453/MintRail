/**
 * Seed the MintRail GitHub repository with its labels and backlog issues.
 *
 *   GITHUB_TOKEN=… pnpm seed:issues -- --repo owner/name            # create what's missing
 *   pnpm seed:issues -- --dry-run                                  # print, touch nothing
 *
 * - The token is read from the environment only (never written anywhere). It needs
 *   "Issues: read and write" on the target repository.
 * - The repository comes from --repo or GITHUB_REPOSITORY.
 * - Idempotent: labels are created only if missing (existing ones are left alone), and each issue
 *   carries a hidden `<!-- mintrail-issue:<key> -->` marker; issues whose marker (or exact
 *   title) already exists, open or closed, are skipped.
 */
import { Octokit } from "@octokit/rest";

import { type Issue, ISSUES, LABELS } from "./github-issues/issues.js";

const MARKER = (key: string): string => `<!-- mintrail-issue:${key} -->`;

type Args = { dryRun: boolean; repo: string | undefined };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, repo: process.env.GITHUB_REPOSITORY };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (a === "--dry-run" || a === "-n") args.dryRun = true;
    else if (a === "--repo") args.repo = argv[++i];
    else if (a.startsWith("--repo=")) args.repo = a.slice("--repo=".length);
    else if (a === "--help" || a === "-h") {
      console.log("usage: seed-github-issues [--dry-run] [--repo owner/name]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function bodyOf(issue: Issue): string {
  return `${issue.body.trimEnd()}\n\n${MARKER(issue.key)}\n`;
}

function validate(): void {
  const keys = new Set<string>();
  const known = new Set(LABELS.map((l) => l.name));
  for (const i of ISSUES) {
    if (keys.has(i.key)) throw new Error(`duplicate issue key ${i.key}`);
    keys.add(i.key);
    for (const l of i.labels) if (!known.has(l)) throw new Error(`issue ${i.key}: unknown label ${l}`);
  }
}

function dryRun(repo: string | undefined): void {
  console.log(`DRY RUN: nothing is sent to GitHub${repo ? ` (target would be ${repo})` : ""}.\n`);
  console.log(`labels (${LABELS.length}): ${LABELS.map((l) => l.name).join(", ")}\n`);
  ISSUES.forEach((i, n) => {
    console.log(`#${String(n + 1).padStart(2)}  ${i.title}`);
    console.log(`     labels: ${i.labels.join(", ")}  ·  body: ${bodyOf(i).length} chars  ·  key: ${i.key}`);
  });
  console.log(`\n${ISSUES.length} issues.`);
}

async function seed(repoSlug: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set (export it in your shell; it is never stored)");
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) throw new Error(`--repo must be owner/name, got ${repoSlug}`);
  const gh = new Octokit({ auth: token, userAgent: "mintrail-issue-seeder" });

  const existingLabels = new Set((await gh.paginate(gh.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 })).map((l) => l.name));
  for (const l of LABELS) {
    if (existingLabels.has(l.name)) {
      console.log(`label  ${l.name}: exists`);
      continue;
    }
    await gh.rest.issues.createLabel({ owner, repo, name: l.name, color: l.color, description: l.description });
    console.log(`label  ${l.name}: created`);
  }

  const existing = await gh.paginate(gh.rest.issues.listForRepo, { owner, repo, state: "all", per_page: 100 });
  const seenBodies = existing.filter((i) => !i.pull_request).map((i) => ({ title: i.title, body: i.body ?? "" }));
  let created = 0;
  for (const issue of ISSUES) {
    const dup = seenBodies.find((i) => i.body.includes(MARKER(issue.key)) || i.title === issue.title);
    if (dup) {
      console.log(`issue  ${issue.key}: exists, skipped`);
      continue;
    }
    const r = await gh.rest.issues.create({ owner, repo, title: issue.title, body: bodyOf(issue), labels: issue.labels });
    created += 1;
    console.log(`issue  ${issue.key}: created #${r.data.number}`);
  }
  console.log(`\ndone: ${created} created, ${ISSUES.length - created} already present.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  validate();
  if (args.dryRun) return dryRun(args.repo);
  if (!args.repo) throw new Error("no repository: pass --repo owner/name or set GITHUB_REPOSITORY");
  await seed(args.repo);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
