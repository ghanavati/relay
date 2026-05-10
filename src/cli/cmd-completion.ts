/**
 * `relay completion <bash|zsh|fish>` — emit a shell completion script for the
 * named shell. Pipe into the shell's completion location:
 *
 *   relay completion bash > /usr/local/etc/bash_completion.d/relay
 *   relay completion zsh  > "${fpath[1]}/_relay"
 *   relay completion fish > ~/.config/fish/completions/relay.fish
 *
 * Or eval directly: `eval "$(relay completion zsh)"`.
 */
import type { CliIO } from './commands.js';

export interface CompletionArgs {
  shell: 'bash' | 'zsh' | 'fish';
}

// Top-level commands. Includes wave 3 (setup, setup-llm, info, update, pause,
// resume, export, project, verify) and wave 4 (tui). The dispatcher in
// src/cli.ts is the source of truth.
const COMMANDS = [
  'run', 'parallel', 'history', 'doctor', 'verify', 'diff', 'compare',
  'init', 'setup', 'setup-llm', 'info', 'update', 'memory', 'context',
  'export', 'pause', 'resume', 'project', 'tui', 'completion', 'help',
  'version',
] as const;

// Memory subactions. Includes wave 4 additions: rollback, consolidate, recent,
// diff, chain, tag-stats, search. The dispatcher in src/cli.ts dispatchMemory
// is the source of truth.
const MEMORY_ACTIONS = [
  'remember', 'recall', 'show-context', 'get', 'why', 'hook', 'to-rules',
  'auto-extract', 'wipe', 'forget', 'tail', 'rollback', 'consolidate',
  'recent', 'diff', 'chain', 'tag-stats', 'search',
] as const;

const CONTEXT_ACTIONS = ['emit'] as const;
const PROJECT_ACTIONS = ['disable', 'enable', 'audit'] as const;
const PROVIDERS = ['codex', 'lmstudio', 'openrouter', 'anthropic'] as const;
const MEMORY_TYPES = ['fact', 'decision', 'lesson', 'context', 'state', 'handoff'] as const;
const STATUSES = ['queued', 'running', 'success', 'error', 'timeout'] as const;
const SHELLS = ['bash', 'zsh', 'fish'] as const;
const EMIT_TARGETS = ['cc', 'codex', 'lmstudio-http', 'lmstudio-cli'] as const;
const TRUST_LEVELS = ['any', 'unverified', 'provisional', 'trusted'] as const;
const EXPORT_FORMATS = ['json', 'md'] as const;
const COLOR_MODES = ['auto', 'always', 'never'] as const;
const SETUP_LLM_TARGETS = ['codex', 'lmstudio', 'openrouter', 'anthropic'] as const;

// Complete flag inventory across all commands. Bash & zsh emit the literal
// `--name`; fish uses `-l name` syntax (see fish() builder).
const FLAGS = [
  'json', 'provider', 'model', 'workdir', 'type', 'tag', 'pinned',
  'token-budget', 'limit', 'status', 'max-concurrency', 'timeout-ms',
  'reasoning-effort', 'auto', 'quick', 'install', 'uninstall', 'rules-file',
  'check', 'apply', 'force', 'color', 'help', 'version',
  // wave 3 / wave 4 additions:
  'global', 'session-end', 'session-end-hook', 'no-global-hook',
  'enable-auto-extract', 'no-shell-edit', 'lm-model', 'everything',
  'interactive', 'clean', 'yes', 'write', 'safe', 'format', 'out',
  'minutes', 'filter', 'since', 'include-expired', 'min-trust',
  'hard', 'confirm', 'expires-in', 'allow-remote', 'enable',
  'from-stdin', 'max-bytes', 'dry-run', 'similarity-threshold',
  'created-after', 'created-before', 'file', 'target', 'types',
  'spec',
] as const;

function bash(): string {
  return `# bash completion for relay
_relay_complete() {
  local cur prev cmd subcmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  subcmd="\${COMP_WORDS[2]}"

  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${COMMANDS.join(' ')}" -- "\$cur") )
    return 0
  fi

  case "\$cmd" in
    memory)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "${MEMORY_ACTIONS.join(' ')}" -- "\$cur") )
        return 0
      fi
      ;;
    context)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "${CONTEXT_ACTIONS.join(' ')}" -- "\$cur") )
        return 0
      fi
      ;;
    project)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "${PROJECT_ACTIONS.join(' ')}" -- "\$cur") )
        return 0
      fi
      ;;
    setup-llm)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "${SETUP_LLM_TARGETS.join(' ')}" -- "\$cur") )
        return 0
      fi
      ;;
    completion)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "${SHELLS.join(' ')}" -- "\$cur") )
        return 0
      fi
      ;;
  esac

  case "\$prev" in
    --provider)  COMPREPLY=( \$(compgen -W "${PROVIDERS.join(' ')}" -- "\$cur") ); return 0;;
    --type)      COMPREPLY=( \$(compgen -W "${MEMORY_TYPES.join(' ')}" -- "\$cur") ); return 0;;
    --status)    COMPREPLY=( \$(compgen -W "${STATUSES.join(' ')}" -- "\$cur") ); return 0;;
    --target)    COMPREPLY=( \$(compgen -W "${EMIT_TARGETS.join(' ')}" -- "\$cur") ); return 0;;
    --min-trust) COMPREPLY=( \$(compgen -W "${TRUST_LEVELS.join(' ')}" -- "\$cur") ); return 0;;
    --format)    COMPREPLY=( \$(compgen -W "${EXPORT_FORMATS.join(' ')}" -- "\$cur") ); return 0;;
    --color)     COMPREPLY=( \$(compgen -W "${COLOR_MODES.join(' ')}" -- "\$cur") ); return 0;;
    --workdir)   COMPREPLY=( \$(compgen -d -- "\$cur") ); return 0;;
    --rules-file|--spec|--out|--file) COMPREPLY=( \$(compgen -f -- "\$cur") ); return 0;;
  esac

  COMPREPLY=( \$(compgen -W "${FLAGS.map(f => `--${f}`).join(' ')}" -- "\$cur") )
}
complete -F _relay_complete relay
`;
}

function zsh(): string {
  return `#compdef relay
# zsh completion for relay
_relay() {
  local -a commands memory_actions context_actions project_actions setup_llm_targets providers types statuses shells emit_targets trust_levels export_formats color_modes
  commands=(${COMMANDS.map(c => `'${c}:'`).join(' ')})
  memory_actions=(${MEMORY_ACTIONS.map(c => `'${c}:'`).join(' ')})
  context_actions=(${CONTEXT_ACTIONS.map(c => `'${c}:'`).join(' ')})
  project_actions=(${PROJECT_ACTIONS.map(c => `'${c}:'`).join(' ')})
  setup_llm_targets=(${SETUP_LLM_TARGETS.map(c => `'${c}:'`).join(' ')})
  providers=(${PROVIDERS.map(c => `'${c}:'`).join(' ')})
  types=(${MEMORY_TYPES.map(c => `'${c}:'`).join(' ')})
  statuses=(${STATUSES.map(c => `'${c}:'`).join(' ')})
  shells=(${SHELLS.map(c => `'${c}:'`).join(' ')})
  emit_targets=(${EMIT_TARGETS.map(c => `'${c}:'`).join(' ')})
  trust_levels=(${TRUST_LEVELS.map(c => `'${c}:'`).join(' ')})
  export_formats=(${EXPORT_FORMATS.map(c => `'${c}:'`).join(' ')})
  color_modes=(${COLOR_MODES.map(c => `'${c}:'`).join(' ')})

  if (( CURRENT == 2 )); then
    _describe -t commands 'relay command' commands
    return
  fi

  case "\${words[2]}" in
    memory)
      if (( CURRENT == 3 )); then
        _describe -t actions 'memory action' memory_actions
        return
      fi
      ;;
    context)
      if (( CURRENT == 3 )); then
        _describe -t actions 'context action' context_actions
        return
      fi
      ;;
    project)
      if (( CURRENT == 3 )); then
        _describe -t actions 'project action' project_actions
        return
      fi
      ;;
    setup-llm)
      if (( CURRENT == 3 )); then
        _describe -t targets 'llm target' setup_llm_targets
        return
      fi
      ;;
    completion)
      if (( CURRENT == 3 )); then
        _describe -t shells 'shell' shells
        return
      fi
      ;;
  esac

  case "\${words[CURRENT-1]}" in
    --provider)  _describe -t providers 'provider' providers; return;;
    --type)      _describe -t types 'memory type' types; return;;
    --status)    _describe -t statuses 'run status' statuses; return;;
    --target)    _describe -t emit_targets 'emit target' emit_targets; return;;
    --min-trust) _describe -t trust_levels 'trust level' trust_levels; return;;
    --format)    _describe -t export_formats 'export format' export_formats; return;;
    --color)     _describe -t color_modes 'color mode' color_modes; return;;
    --workdir)   _path_files -/; return;;
    --rules-file|--spec|--out|--file) _files; return;;
  esac

  _arguments \\
${FLAGS.map(f => `    '--${f}[${f} flag]' \\`).join('\n').replace(/ \\$/, '')}
}
compdef _relay relay
`;
}

function fish(): string {
  const cmd = 'complete -c relay';
  const lines: string[] = [
    '# fish completion for relay',
    `${cmd} -f`,
  ];
  for (const c of COMMANDS) lines.push(`${cmd} -n '__fish_use_subcommand' -a '${c}'`);
  for (const a of MEMORY_ACTIONS) lines.push(`${cmd} -n '__fish_seen_subcommand_from memory' -a '${a}'`);
  for (const a of CONTEXT_ACTIONS) lines.push(`${cmd} -n '__fish_seen_subcommand_from context' -a '${a}'`);
  for (const a of PROJECT_ACTIONS) lines.push(`${cmd} -n '__fish_seen_subcommand_from project' -a '${a}'`);
  for (const a of SETUP_LLM_TARGETS) lines.push(`${cmd} -n '__fish_seen_subcommand_from setup-llm' -a '${a}'`);
  for (const s of SHELLS) lines.push(`${cmd} -n '__fish_seen_subcommand_from completion' -a '${s}'`);
  // Flags with constrained value sets:
  lines.push(`${cmd} -l provider -d 'provider' -xa '${PROVIDERS.join(' ')}'`);
  lines.push(`${cmd} -l type -d 'memory type' -xa '${MEMORY_TYPES.join(' ')}'`);
  lines.push(`${cmd} -l status -d 'run status' -xa '${STATUSES.join(' ')}'`);
  lines.push(`${cmd} -l target -d 'emit target' -xa '${EMIT_TARGETS.join(' ')}'`);
  lines.push(`${cmd} -l min-trust -d 'trust level' -xa '${TRUST_LEVELS.join(' ')}'`);
  lines.push(`${cmd} -l format -d 'export format' -xa '${EXPORT_FORMATS.join(' ')}'`);
  lines.push(`${cmd} -l color -d 'color mode' -xa '${COLOR_MODES.join(' ')}'`);
  lines.push(`${cmd} -l workdir -d 'workdir path' -ra '(__fish_complete_directories)'`);
  lines.push(`${cmd} -l rules-file -d 'rules file path' -r`);
  lines.push(`${cmd} -l spec -d 'spec file path' -r`);
  lines.push(`${cmd} -l out -d 'output file path' -r`);
  lines.push(`${cmd} -l file -d 'file path' -r`);
  // Flags without constrained values (free-form):
  const constrained = new Set([
    'provider', 'type', 'status', 'target', 'min-trust', 'format', 'color',
    'workdir', 'rules-file', 'spec', 'out', 'file',
  ]);
  for (const f of FLAGS) {
    if (constrained.has(f)) continue;
    if (f === 'help') lines.push(`${cmd} -l help -s h -d 'show help'`);
    else if (f === 'version') lines.push(`${cmd} -l version -s V -d 'show version'`);
    else lines.push(`${cmd} -l ${f} -d '${f} flag'`);
  }
  return lines.join('\n') + '\n';
}

export function executeCompletionCommand(args: CompletionArgs, io: CliIO): number {
  let script: string;
  if (args.shell === 'bash') script = bash();
  else if (args.shell === 'zsh') script = zsh();
  else if (args.shell === 'fish') script = fish();
  else {
    io.stderr(`unknown shell: ${String(args.shell)}. Try: bash, zsh, fish.\n`);
    return 2;
  }
  io.stdout(script);
  return 0;
}
