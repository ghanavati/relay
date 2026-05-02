import * as fs from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContextLayer, ContextLayerProvider } from "./layers.js";

const execFileAsync = promisify(execFile);
const BRIEF_FILENAME = ".relay/brief.md";

async function findGitRoot(workdir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workdir,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return resolve(workdir);
  }
}

async function readNearestBrief(workdir: string): Promise<string | null> {
  const root = await findGitRoot(workdir);
  let current = resolve(workdir);

  while (true) {
    try {
      const content = (await fs.readFile(join(current, BRIEF_FILENAME), "utf8")).trim();
      if (content.length > 0) return content;
    } catch {
      // not found at this level — continue traversal
    }

    if (current === root) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    if (parent !== root && !parent.startsWith(root + sep)) return null;
    current = parent;
  }
}

export function createBriefLayerProvider(): ContextLayerProvider {
  return {
    id: "project_knowledge",
    async load(args: { workdir: string }): Promise<ContextLayer | null> {
      const content = await readNearestBrief(args.workdir);
      if (!content) return null;
      return { id: "project_knowledge", content };
    },
  };
}

export const BRIEF_TEMPLATE = `# Project Brief

## What We're Building
<!-- One-line product description. What it is and what it does. -->

## Audience
<!-- Who uses this. Their primary need or job-to-be-done. -->

## Pains We Solve
<!-- Name each pain with a label, then how this product addresses it. -->
- **[Pain name]**: [How we solve it]

## Value Propositions
<!-- For each audience pain, the specific claim we make. -->
- [Audience pain] → [Our answer]

## Architecture
<!-- Core technical design: key patterns, storage, runtime model. -->

## Key Decisions
<!-- Why we chose what we chose. Date + decision + rationale. -->
- [YYYY-MM-DD] [Decision]: [Rationale]

## Guidelines
<!-- Preferences, best practices, and standards we adhere to. -->
- [Rule or preference]

## Invariants
<!-- Rules we will not compromise on. -->
- [Non-negotiable rule]
`;

export async function writeBriefTemplate(workdir: string): Promise<string> {
  const relayDir = join(resolve(workdir), ".relay");
  await fs.mkdir(relayDir, { recursive: true });
  const briefPath = join(relayDir, "brief.md");
  await fs.writeFile(briefPath, BRIEF_TEMPLATE, { flag: "wx" }); // fail if exists
  return briefPath;
}

export async function readBrief(workdir: string): Promise<string | null> {
  return readNearestBrief(workdir);
}
