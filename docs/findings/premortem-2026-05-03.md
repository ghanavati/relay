# Premortem Transcript — Relay v0.1.0

**Generated:** 2026-05-03
**Method:** Klein-method premortem with 8 parallel deep-dive investigators
**Frame:** It is 2026-11-03. Six months have passed. Relay has failed.

---

## 1. Context gathered

### What it is
Relay v0.1.0 — solo CLI for delegating bounded coding tasks to AI workers (Codex CLI, OpenRouter, LM Studio, Anthropic) with local SQLite audit trail, persistent memory, and parallel dispatch. Located at `/Users/ghanavati/ai-stack/projects/Relay/`. Extracted from `relay-mcp` on 2026-05-02. Tech: TypeScript, Node ≥20, better-sqlite3 (native), Zod, node:test. License: AGPL-3.0-or-later. NOT on npm. README says "install from source" via `git clone + npm install + npm link`.

Explicitly DROPPED from extraction: compliance/regulatory artifacts (EU AI Act, SR 11-7, DORA), hosted mode, billing, model registry lifecycle, oversight workflows.

### Who it's for
Solo developers wanting CLI-driven AI delegation with audit trail. Eventually OSS contributors. Author is the primary first user — also maintains relay-mcp (parent), gstack, paul, gsd, several design tools.

### Success 6 months out (2026-11-03)
- **E (primary):** Author has migrated from relay-mcp → Relay as daily driver
- **A (primary):** Relay published on npm, has actual users beyond the author, traction signal (issues, stars, contributions)
- **D (stretch, "engine for now"):** paid distribution path preserved via engine quality

### Failure means
At least one of: (1) author still using relay-mcp daily, not Relay; (2) Relay never made it to npm OR shipped to npm with ≤20 users / no traction; (3) engine fragmented or rotted before D became viable.

---

## 2. Raw failure reasons (8)

1. **Inherited test suite never triaged** — AGENTS.md flags "many depend on dropped modules"; silent regressions slip through.
2. **Author never actually dogfooded Relay** — relay-mcp stays daily driver; engine never battle-tested.
3. **AGPL-3.0 strangles adoption** — license filters employed-developer audience and chokes D path.
4. **Distribution friction kills casual eval** — no npm publish + better-sqlite3 native install issues.
5. **Author attention fragmented across many projects** — Relay starves on residual time.
6. **Weak differentiation in crowded CLI agent space** — pitch sounds identical to claude-code/aider.
7. **Engine-first trap** — "engine for now" becomes "engine forever, surface never."
8. **Split-brain with relay-mcp burns the maintainer** — both engines drift, paid path's gravity well starves free path.

---

## 3. Deep-dive investigations

### Failure #1 · Inherited test suite was never triaged

**Failure story:**
Two weeks in, the author tagged v0.2 with "tests passing" and shipped a parallel-dispatch fix that landed during a Codex spec session. What he didn't notice: the inherited tests for `recordRunDiff`, `acquireWorkdirMutex`, and the snapshot reconciler had been silently importing from dropped compliance modules. After the relay-mcp extraction, those imports failed at module-load time, and node:test reported them as "0 ok, 0 fail" — counted as pass. Coverage looked unchanged because the green column never moved. He copied his relay-mcp habit of running `node --test dist/**/*.test.js | tail -10` and looking for `# fail 0`, which is exactly what he got. By v0.3, three weeks later, the diff snapshotter was reconciling against stale pre-states on parallel worktrees, and the run-recorder was double-writing rows on retries. Both regressions had no live test guarding them.

Then someone on Hacker News tried it. They ran `relay delegate_parallel` against a real repo with eight isolated tasks; the worktree merge step deleted files that had been touched in two lanes because the conflict resolver never saw them. The user posted: "relay just ate three days of work." Two more reports came in within 48 hours — one about better-sqlite3 db locked under concurrent CLI invocations, one about MemoryStore corruption after a partial commit. The author was mid-week on relay-mcp compliance work for a bank pilot and didn't respond for four days. By then the GitHub issues had screenshots, the post had 200 upvotes, and the npm package (he'd just published v0.3 to npm) had its first 1-star reviews. He pulled it. Nobody trusted it after.

**Underlying assumption:** That a test suite which compiles and reports green is actually exercising the code paths it claims to cover.

**Early warning signs:**
- `node --test dist/**/*.test.js` reports a total test count materially lower than relay-mcp's (~1635) without explicit removal — the delta IS the silent skips.
- Any test file in `dist/` importing from a path containing `compliance/`, `oversight/`, `billing/`, `hosted/`, or `model-registry/` — those imports fail at load and the whole file vanishes silently.

---

### Failure #2 · Author never actually dogfooded Relay

**Failure story:**
The migration never happened because the author's actual work doesn't fit Relay's scope. relay-mcp's MemoryStore had 200+ entries — Berry span format quirks, LM Studio preset gotchas, GLM-4.7-Flash 16-lane profile, qwen3-coder-next leash rules, the Onyx-blocks-OR incident, the Codex deletes-onyx-auto-attach pattern. None of that lived in Relay's fresh `~/.relay/` directory. On 2026-05-04, the author opened a terminal to dispatch a ≥2-file test generation batch and reflexively typed `mcp__relay-mcp__delegate_parallel` because that's what the auto-dispatch rule in `.claude/CLAUDE.md` says. Relay's CLI required re-learning flags and re-configuring providers. That five-minute friction, multiplied across ten dispatches a day, was unwinnable.

By mid-May the pattern locked in. The compliance work for the bank demo (AGENTS-COMPLIANCE.md items #1, #2, #7) was happening in relay-mcp — Relay had explicitly dropped sign_off, validate, oversight assignments, the whole governance surface. Every medical-device IEC 62304 question routed to relay-mcp. Every paid OpenRouter dispatch needed cost confirmation policies that lived in relay-mcp's guardian config. Relay handled toy tasks; relay-mcp handled real work. Weekend commits to Relay tapered: 14 in May, 6 in June, 2 in July. The commit-or-lose-on-merge edge case the author hit on 2026-05-09 went unfixed until August because it never bit twice in the same week. By month 4 the author told a friend Relay was "the clean version, experimental" — which was the obituary. With no daily-driver pressure, the install-from-source friction never became npm publication, and A had no engine to stand on.

**Underlying assumption:** That extracting a clean engine would create a clean tool the author would naturally adopt — ignoring that relay-mcp's "bloat" (compliance, memory, oversight) is exactly what the author's paying work requires.

**Early warning signs:**
- This week's terminal history: count `mcp__relay-mcp__*` and `relay-mcp` invocations vs `relay` invocations. If the ratio isn't shifting toward Relay within 7 days, it never will.
- Whether the next ≥2-file LM Studio auto-dispatch (the rule fires multiple times per session) actually goes through Relay's CLI, or whether the author falls back to `delegate_parallel` because the GLM/Qwen routing rules aren't ported yet.

---

### Failure #3 · AGPL-3.0 strangled adoption

**Failure story:**
The first AGPL warning came in week 2: a developer at a fintech opened an issue titled "license question" asking whether running Relay against their internal codebase would "infect" the codebase under AGPL. The author wrote a careful answer — AGPL applies to Relay itself, not the code it operates on — but the issue sat with no follow-up reply. That pattern repeated. By month 2, three separate Hacker News commenters on a "show HN" thread argued the license rather than the tool. By month 4, the author noticed that every fork on GitHub was a personal account with zero subsequent commits — people clicking fork to read code, not to contribute. The author posted in r/programming asking for feedback; the top comment was about license choice.

Meanwhile, the audience that *did* engage was the wrong one: license maximalists who wanted to debate copyleft virtue, plus a handful of solo hobbyists who tried it once and never came back. Star count crawled from 12 to 38 over six months. Two PRs landed — both small, both now AGPL-encumbered. When the author drafted a relicense to Apache-2.0 in October to unlock the npm/paid path (D), the contributor whose 40-line PR fixed a worktree bug went silent on the CLA request. Without unanimous consent, the author was stuck. The "engine for now, paid path preserved" stretch goal was now blocked by two PRs they couldn't unwind without a rewrite.

**Underlying assumption:** That AGPL-3.0 was a neutral default for a CLI tool, when in practice it functions as a filter that excludes the employed-developer audience and contaminates the paid-distribution path the author wanted to preserve.

**Early warning signs:**
- License-related issues or comments appearing before usage-related ones (ratio inverted from healthy OSS projects).
- Forks on GitHub with zero downstream commits — readers, not contributors — outnumbering active users by week 4.

---

### Failure #4 · Distribution friction killed casual evaluation

**Failure story:**
The HN comment landed on a Tuesday in late June: "anyone tried Relay? AGPL audit-trail wrapper around codex/aider." Two hundred curious devs clicked through. The README told them to `git clone`, `npm install`, `npm run build`, `npm link` — and the install died at `better-sqlite3` for the Windows users (~30%), for the macOS users without Xcode CLT (~20%), and for the Linux users on Node 22 vs the prebuilt binary's Node 20 (~15%). Of the survivors, most hit `relay run "fix this"` and got an error: no provider configured. Was it `OPENROUTER_API_KEY`? `ANTHROPIC_API_KEY`? Did they need to install Codex CLI first? Three docs files later, they closed the tab. Total time invested: 12 minutes. Total successful first-delegations: maybe eight people.

By August, the pattern was visible in the GitHub traffic graph: stars climbing on news cycles, clones following stars, but issues filed almost entirely about installation — never about behavior. No screenshots on Twitter. No "I switched from aider" posts. The competitors all shipped `npm install -g claude-code` or `brew install plandex`; Relay shipped an honest README that read, to a casual evaluator, exactly like "this isn't ready." Word-of-mouth needs a working demo, and the demo never happened in anyone's terminal but the author's.

By November, the author was still daily-driving it (E met). Real users beyond the author: roughly four, all friends who got walked through setup over Discord. Not on npm. A met at zero.

**Underlying assumption:** That developers curious enough to read the README would be patient enough to compile a native module and configure a provider before seeing Relay do anything.

**Early warning signs:**
- GitHub Issues this month skew toward "install failed" / "node-gyp error" / "which provider do I use" rather than feature requests or behavior bugs — the funnel is dying at step 1, not step 5.
- Clone-to-star ratio inverts: people are cloning to try, not starring after trying. No external screenshots, gifs, or "I tried Relay" tweets appear in search within 2 weeks of any mention.

---

### Failure #5 · Author's attention fragmented across too many projects

**Failure story:**
The first three weeks of May went well — Relay v0.1 → v0.2, a polished `relay run` flow, the SQLite audit projection working, two GitHub stars, a Hacker News mention that brought 14 first-time users. Then on May 28 a prospective bank asked relay-mcp for an SR 11-7 demo, and the author's calendar collapsed back into the compliance product. R-38 wasn't done. R-15 had drifted. The bank wanted artifacts by mid-June. Relay got squeezed to Saturday mornings — and most Saturdays were spent on gstack, where a skill the author actually used daily had broken after a Claude Code update. paul needed a migration. The i-* design skills had three open issues. Relay's issue tracker accumulated four bug reports between June 12 and July 3 with no response.

By August, Relay was v0.2.4 — a single bug-fix release in 9 weeks. Two early users had filed "is this still maintained?" comments and migrated to aider; one wrote a polite blog post comparing Relay unfavorably to claude-code's native parallel dispatch (which shipped in July). The author tried a "Relay week" in September but spent four of five days fighting a regression from a Node 22 update. By October, the README still said v0.2, npm showed a 6-week-old release, and the GitHub insights graph showed 11 commits in 30 days — 9 of them to relay-mcp. The premortem assumption that Relay was a "spinoff that runs on weekends" turned out to be the failure mode itself: weekends are where projects go to die when a solo developer has six of them.

**Underlying assumption:** That a solo developer with one paying-attention project (relay-mcp's compliance roadmap) and five maintenance projects can also ship and support a public OSS tool on residual attention.

**Early warning signs:**
- Two consecutive weekends pass without a Relay commit while relay-mcp/gstack/paul receive commits — attention is already allocated elsewhere by default, not exception.
- A Relay issue or bug report sits unanswered for >5 days while the author is active on GitHub in other repos — the response-latency gap is the public signal contributors use to decide "abandoned."

---

### Failure #6 · Weak differentiation in a crowded space

**Failure story:**
By July 2026, Relay had 47 GitHub stars, 12 npm weekly downloads, and three external users who'd tried it once. The pattern was consistent across HN, Reddit r/LocalLLaMA, and dev.to comment threads: "How is this different from aider?" The author wrote three iterations of the README — each clearer to him, each still leading with "delegate bounded coding tasks to AI workers." Aider's tagline was "AI pair programming in your terminal." Plandex's was "long-running agentic tasks." Cline had a polished VSCode extension. Relay sat in a sea of taglines that all sounded identical, and the SQLite audit trail — the actual moat — was buried in a "Features" bullet list at line 47.

The cruelest part: when users *did* hit hallucinations or destructive AI edits in the wild, they didn't think "I need an audit trail tool." They reached for git reflog, complained on Twitter, and moved on. Relay never inserted itself into that pain moment because the pitch didn't name the pain. A late-September Show HN post got 4 upvotes and one comment: "isn't this just claude-code with extra steps?" The author tried pivoting the pitch to "forensic CLI for AI-generated code" in October, but by then the indexing was set — every directory listing, every awesome-list submission, every search result had Relay categorized as "another agent CLI." The author kept using it himself (the E goal held), but A and D never arrived. By November, two competitors had shipped audit-trail features as line items, and Relay's differentiator became a checkbox someone else owned.

**Underlying assumption:** That capability-first positioning ("here's what it does") would convert in a category where ten tools already do roughly the same thing, when only pain-first positioning ("here's what it saves you from") cuts through.

**Early warning signs:**
- First 5 friends/strangers shown the README cannot articulate, in their own words, how Relay differs from claude-code or aider within 30 seconds of skimming.
- Inbound questions — issues, DMs, HN comments — repeatedly ask "how is this different from X?" rather than "can it do Y?" The former means positioning failed; the latter means it landed.

---

### Failure #7 · Engine-first trap

**Failure story:**
The author spent May through August on the engine: schema migration v3 → v4 for retention events, a circuit breaker rewrite in `RunnerDispatcher`, the memory store gaining recall-budget shaping, parallel dispatch surviving 16 lanes on GLM-4.7-flash. Each improvement was real, measurable, and invisible. By September, `relay run` and `relay delegate_parallel` from the CLI were genuinely better than anything the 8 competing agentic CLIs shipped — but no one outside the author could perceive it. The README at commit `8b41f5ef` (Nov 3) read almost identically to commit `4e258f13` (May 3): "delegate coding tasks to AI workers with audit trail." When a friend asked for a demo in October, the author screenshared a terminal running JSON output. The friend nodded politely.

The dream from `project_relay_dreams.md` — "describe → multiple models execute simultaneously → compare/select visually" — sat in the planning folder for six months as `studio` module, status: scaffolded. It kept being the next phase, after just one more dispatch hardening pass. By November, npm had 11 weekly downloads, all the author's machines. There was no screencast to tweet, no before/after magic moment, no surface a stranger could fall in love with in 30 seconds. The author's own memory file `project_engine_first_product_last.md` had warned, verbatim: "Every backend capability must surface in UI in same phase. 24 invisible phases = no product." It was written in April and ignored every week since.

**Underlying assumption:** That a sufficiently good engine generates its own surface — that quality leaks upward into product visibility without dedicated UI work.

**Early warning signs:**
- Two consecutive weeks where every commit touches `src/runtime/`, `src/workers/`, or `src/memory/` and zero commits touch a user-facing demo, screencast, README hero section, or `studio` module surface.
- The author cannot answer "what's the 30-second demo?" without describing internal architecture — no visual artifact exists they could send to a non-technical friend.

---

### Failure #8 · Split-brain with relay-mcp burned the maintainer

**Failure story:**
Month 2, late June. The author is debugging a Codex worker in relay-mcp — a race between `acquireWorkdirMutex` and the snapshot diff logic, the kind of subtle bug that surfaces only under 8-lane GLM dispatch. They fix it in `src/runtime/runner-dispatcher.ts`, write the test, ship it. The compliance work is hot: a bank pilot needs SR 11-7 sign-off artifacts by Friday, and the dispatch fix unblocks a validation run. Relay v0.1.0 sits in `/Users/ghanavati/ai-stack/projects/Relay/` with the same bug, but no one is running 8 lanes against it because no one is running it for anything load-bearing. The author makes a mental note. The mental note evaporates by Tuesday.

Three weeks later, a hobbyist on npm files relay#23: "delegate_parallel hangs intermittently at 4+ workers." The author opens both repos side-by-side and discovers the dispatcher has drifted — Relay's slimmed engine removed the hosted/ telemetry hooks, so the file structure no longer matches. The cherry-pick fails. They hand-port. Two weeks after that, the same thing happens with the provider config schema (Relay added a `lmstudio.preset` field that relay-mcp doesn't need). Then with retention logic, where `~/.relay/` and `~/.relay-mcp/` have diverged on TTL defaults. By month 4, the author is keeping a private spreadsheet of "things fixed in relay-mcp that need backporting." By month 6, the spreadsheet has 14 rows, four are blocked on non-trivial conflicts, and the bank pilot wants a feature that requires touching the dispatcher again. Relay's last commit is from August.

**Underlying assumption:** That a fork shared between a paid path and a free path can be maintained by one person without the paid path's gravity well silently starving the free one.

**Early warning signs:**
- Within 2 weeks: any single bug fix touching `src/runtime/` or `src/workers/` in relay-mcp that does NOT also land in Relay the same day. The first un-backported fix is the one that establishes the pattern.
- Within 4 weeks: the author writing the phrase "I'll port this later" in a commit message, session doc, or memory entry — once that sentence appears, the backport queue exists and is already growing.

---

## 4. Synthesis

### Most Likely Failure
**#2 — You never actually dogfood Relay.** Structural and immediate. `.claude/CLAUDE.md` in relay-mcp already mandates `mcp__relay-mcp__delegate_parallel` for ≥2-file batches. 200+ memory entries (LM Studio profiles, GLM/Qwen routing, Berry quirks) live in `~/.relay-mcp/`. Muscle memory fires daily from day 1. Without an explicit migration plan, this is what happens by default. It also cascades: no dogfood → no battle-testing → no engine quality → A ships rough → A fails.

### Most Dangerous Failure
**#1 — Inherited test suite reports green while silently skipping.** Less likely than #2 but causes worse damage if it lands. AGENTS.md flags it explicitly. Path to disaster: silent skips → data-loss bug ships → user posts "relay just ate my work" on HN → reputation tag sticks permanently. Recovery curve is brutal — "this tool eats your repo" doesn't unwind.

### Hidden Assumption (cross-agent)
**"Extracting from `relay-mcp` creates a separate-but-equal product."** Across #2, #6, #7, and #8, the same load-bearing belief: that the value lives in the engine, so extracting the engine extracts the product. But Relay's value lives in the **ecosystem** — the memory entries, AGENTS rules, learned LM Studio profiles, Berry integration paths, audit-trail-as-compliance. Without that ecosystem, the engine is a commodity competing against claude-code, aider, codex CLI on table stakes.

### Revised Plan (concrete, mapped to failure modes)

1. **(#1) Test triage gate — this week.** Run `npm test 2>&1 | tail -3`, compare to relay-mcp's ~1635 baseline. `grep -rE "from.*(compliance|oversight|billing|hosted|model-registry|validation|guardian)" src/` — every match in a test file is a silent-skip candidate. Delete or rewrite. Don't ship v0.2 until count is honest.
2. **(#2) 14-day dogfood test — starting today.** Every routine task that triggers the ≥2-file auto-dispatch rule MUST go through `relay run`, not `mcp__relay-mcp__delegate_parallel`. Track invocations. <30 calls in 14 days = Relay isn't usable for daily work.
3. **(#3) License decision — within 7 days, before any external PR.** (a) keep AGPL and document why; (b) relicense to Apache-2.0 NOW while contributors=0; (c) dual-license. After PR #1 lands, (b) becomes hard.
4. **(#4) Pre-publish gate — no HN/Twitter post until `npm install -g relay` works.** 60-second magic moment in README. Pin Node version. Tested by 3 strangers on macOS / Windows WSL2 / Linux clean installs.
5. **(#5) Weekly hour cap.** Decide a number you can defend. <4 hours/week = keep repo private until calendar opens.
6. **(#6) Replace README hero — pain-first, not capability-first.** Test 3 alternatives that lead with what it saves you from. Show 5 strangers; if they can't articulate the differentiator in 30 seconds, the pitch is wrong.
7. **(#7) Engine work must serve a visible artifact.** Every engine improvement ships with one user-visible change: screencast, README hero update, working `relay studio` demo. Two weeks of all-runtime/-workers commits = trap.
8. **(#8) Pick one canonical engine — within 30 days.** Either Relay is daily driver and relay-mcp is "compliance edition" (one-way port), or relay-mcp stays primary and Relay is archive. "Two coequal engines maintained by one person" has no successful precedent.

### Pre-Launch Checklist

1. **Test count parity.** `npm test 2>&1 | tail -3` shows total tests within 80% of relay-mcp's ~1635 baseline OR every removed test file is documented with reason. (Mitigates #1)
2. **14-day dogfood log.** ≥50 real tasks dispatched via `relay run`. Below 50 = not ready. (Mitigates #2 + #5)
3. **License rationale in writing.** `LICENSE-RATIONALE.md` answering: "if audience is mostly employed devs, why is AGPL OK?" (Mitigates #3)
4. **One-line install + 60-second magic moment.** `npm install -g relay && relay run "..."` works on macOS / Windows WSL2 / Linux. Tested by 3 strangers. (Mitigates #4)
5. **30-second pitch test.** 5 strangers shown the README hero — at least 3 articulate the differentiator vs claude-code/aider without prompting. (Mitigates #6)
