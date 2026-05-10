import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { executeCompletionCommand } from './cmd-completion.js';
import type { CliIO } from './commands.js';

interface CapturedIO {
  io: CliIO;
  stdout: string[];
  stderr: string[];
}

function makeIO(): CapturedIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { cwd: '/tmp', stdout: (m) => stdout.push(m), stderr: (m) => stderr.push(m) },
    stdout,
    stderr,
  };
}

describe('executeCompletionCommand', () => {
  test('bash: returns 0 with _relay_complete and complete -F', () => {
    const cap = makeIO();
    const code = executeCompletionCommand({ shell: 'bash' }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /_relay_complete\(\)/);
    assert.match(out, /complete -F _relay_complete relay/);
  });

  test('zsh: returns 0 with #compdef relay and _describe', () => {
    const cap = makeIO();
    const code = executeCompletionCommand({ shell: 'zsh' }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.ok(out.startsWith('#compdef relay'), 'zsh script must start with #compdef relay');
    assert.match(out, /_describe/);
  });

  test('fish: returns 0 with complete -c relay -f and __fish_use_subcommand', () => {
    const cap = makeIO();
    const code = executeCompletionCommand({ shell: 'fish' }, cap.io);
    assert.strictEqual(code, 0);
    const out = cap.stdout.join('');
    assert.match(out, /complete -c relay -f/);
    assert.match(out, /__fish_use_subcommand/);
  });

  test('all three outputs include providers list (codex, lmstudio, openrouter, anthropic)', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      assert.match(out, /codex/, `${shell}: should contain codex`);
      assert.match(out, /lmstudio/, `${shell}: should contain lmstudio`);
      assert.match(out, /openrouter/, `${shell}: should contain openrouter`);
      assert.match(out, /anthropic/, `${shell}: should contain anthropic`);
    }
  });

  test('all three outputs include memory actions (remember, recall, show-context, get, hook, to-rules)', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      assert.match(out, /remember/, `${shell}: should contain remember`);
      assert.match(out, /recall/, `${shell}: should contain recall`);
      assert.match(out, /show-context/, `${shell}: should contain show-context`);
      assert.match(out, /\bget\b/, `${shell}: should contain get`);
      assert.match(out, /hook/, `${shell}: should contain hook`);
      assert.match(out, /to-rules/, `${shell}: should contain to-rules`);
    }
  });

  test('invalid shell returns 2 with stderr error', () => {
    const cap = makeIO();
    const code = executeCompletionCommand(
      // bypass type checking to test runtime guard
      { shell: 'powershell' as 'bash' },
      cap.io
    );
    assert.strictEqual(code, 2);
    const err = cap.stderr.join('');
    assert.match(err, /unknown shell/);
  });

  test('bash includes top-level commands list (run, parallel, history, doctor, etc.)', () => {
    const cap = makeIO();
    executeCompletionCommand({ shell: 'bash' }, cap.io);
    const out = cap.stdout.join('');
    for (const cmd of ['run', 'parallel', 'history', 'doctor', 'diff', 'compare', 'init', 'memory', 'completion', 'help']) {
      assert.match(out, new RegExp(`\\b${cmd}\\b`), `bash: should contain command "${cmd}"`);
    }
  });

  test('zsh includes top-level commands list', () => {
    const cap = makeIO();
    executeCompletionCommand({ shell: 'zsh' }, cap.io);
    const out = cap.stdout.join('');
    for (const cmd of ['run', 'parallel', 'history', 'doctor', 'memory', 'completion']) {
      assert.match(out, new RegExp(`\\b${cmd}\\b`), `zsh: should contain command "${cmd}"`);
    }
  });

  test('fish includes top-level commands list', () => {
    const cap = makeIO();
    executeCompletionCommand({ shell: 'fish' }, cap.io);
    const out = cap.stdout.join('');
    for (const cmd of ['run', 'parallel', 'history', 'doctor', 'memory', 'completion']) {
      assert.match(out, new RegExp(`\\b${cmd}\\b`), `fish: should contain command "${cmd}"`);
    }
  });

  test('all three include common json/provider/workdir flag names', () => {
    // bash & zsh use literal `--json` in completion lists; fish uses `-l json`.
    // Assert the flag NAME appears somewhere — the syntax differs per shell.
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      const jsonRe = shell === 'fish' ? /-l json\b/ : /--json/;
      const providerRe = shell === 'fish' ? /-l provider\b/ : /--provider/;
      const workdirRe = shell === 'fish' ? /-l workdir\b/ : /--workdir/;
      assert.match(out, jsonRe, `${shell}: should contain json flag`);
      assert.match(out, providerRe, `${shell}: should contain provider flag`);
      assert.match(out, workdirRe, `${shell}: should contain workdir flag`);
    }
  });

  test('memory types appear in completion (fact, decision, lesson, etc.)', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      assert.match(out, /fact/, `${shell}: should contain fact`);
      assert.match(out, /decision/, `${shell}: should contain decision`);
      assert.match(out, /lesson/, `${shell}: should contain lesson`);
      assert.match(out, /handoff/, `${shell}: should contain handoff`);
    }
  });

  // Wave 3 commands: setup, setup-llm, info, update, pause, resume, export,
  // verify, project (with disable/enable/audit subactions).
  test('wave 3: top-level commands appear in all three shells', () => {
    const wave3 = [
      'setup', 'setup-llm', 'info', 'update', 'pause', 'resume',
      'export', 'verify', 'project',
    ];
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      for (const cmd of wave3) {
        assert.match(out, new RegExp(`\\b${cmd}\\b`), `${shell}: should contain wave 3 command "${cmd}"`);
      }
    }
  });

  test('wave 3: project subactions (disable, enable, audit) appear', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      assert.match(out, /\bdisable\b/, `${shell}: should contain "disable"`);
      assert.match(out, /\benable\b/, `${shell}: should contain "enable"`);
      assert.match(out, /\baudit\b/, `${shell}: should contain "audit"`);
    }
  });

  // Wave 4 memory subactions added in this dispatch series.
  test('wave 4: memory subactions (rollback, consolidate, recent, diff, chain, tag-stats, search) appear', () => {
    const wave4Memory = ['rollback', 'consolidate', 'recent', 'diff', 'chain', 'tag-stats', 'search'];
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      for (const action of wave4Memory) {
        assert.match(out, new RegExp(`\\b${action.replace('-', '\\-')}\\b`), `${shell}: should contain memory action "${action}"`);
      }
    }
  });

  // Wave 4 top-level: tui.
  test('wave 4: tui top-level command appears', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      assert.match(out, /\btui\b/, `${shell}: should contain tui`);
    }
  });

  // Memory subactions added between original v0.1.0 and now (why, forget,
  // auto-extract, wipe, tail).
  test('all memory subactions from cli.ts dispatcher appear', () => {
    const allMemoryActions = [
      'remember', 'recall', 'show-context', 'get', 'why', 'hook', 'to-rules',
      'auto-extract', 'wipe', 'forget', 'tail', 'rollback', 'consolidate',
    ];
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      for (const action of allMemoryActions) {
        assert.match(out, new RegExp(`\\b${action.replace('-', '\\-')}\\b`), `${shell}: should contain memory action "${action}"`);
      }
    }
  });

  // Context subaction (emit) added wave 3.
  test('context subaction (emit) appears in all three shells', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      assert.match(out, /\bemit\b/, `${shell}: should contain context emit`);
      assert.match(out, /\bcontext\b/, `${shell}: should contain context`);
    }
  });

  // Wave 3 / wave 4 flags should appear (using shell-appropriate syntax).
  test('wave 3/4 flags appear with correct shell syntax', () => {
    const flags = [
      'global', 'session-end-hook', 'no-global-hook', 'enable-auto-extract',
      'lm-model', 'everything', 'interactive', 'clean', 'yes', 'safe',
      'format', 'out', 'minutes', 'min-trust', 'hard', 'confirm',
      'expires-in', 'allow-remote', 'enable', 'from-stdin', 'max-bytes',
      'dry-run', 'similarity-threshold', 'target', 'types',
    ];
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      for (const flag of flags) {
        const re = shell === 'fish' ? new RegExp(`-l ${flag.replace('-', '\\-')}\\b`) : new RegExp(`--${flag.replace('-', '\\-')}\\b`);
        assert.match(out, re, `${shell}: should contain flag --${flag}`);
      }
    }
  });

  // Trust-level / target / format / color value-completions appear.
  test('value sets (emit targets, trust levels, export formats, color modes) appear', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const cap = makeIO();
      executeCompletionCommand({ shell }, cap.io);
      const out = cap.stdout.join('');
      // Emit targets
      assert.match(out, /\bcc\b/, `${shell}: should contain emit target "cc"`);
      assert.match(out, /lmstudio-http/, `${shell}: should contain emit target "lmstudio-http"`);
      assert.match(out, /lmstudio-cli/, `${shell}: should contain emit target "lmstudio-cli"`);
      // Trust levels
      assert.match(out, /\bunverified\b/, `${shell}: should contain trust "unverified"`);
      assert.match(out, /\bprovisional\b/, `${shell}: should contain trust "provisional"`);
      assert.match(out, /\btrusted\b/, `${shell}: should contain trust "trusted"`);
      // Export formats (md is short — just ensure it appears as standalone token)
      assert.match(out, /\bjson\b/, `${shell}: should contain format "json"`);
      assert.match(out, /\bmd\b/, `${shell}: should contain format "md"`);
      // Color modes
      assert.match(out, /\bauto\b/, `${shell}: should contain color "auto"`);
      assert.match(out, /\balways\b/, `${shell}: should contain color "always"`);
      assert.match(out, /\bnever\b/, `${shell}: should contain color "never"`);
    }
  });
});
