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

const COMMANDS = [
  'run', 'parallel', 'history', 'doctor', 'diff', 'compare', 'init',
  'update', 'memory', 'completion', 'help',
] as const;

const MEMORY_ACTIONS = ['remember', 'recall', 'show-context', 'get', 'hook', 'to-rules'] as const;
const PROVIDERS = ['codex', 'lmstudio', 'openrouter', 'anthropic'] as const;
const MEMORY_TYPES = ['fact', 'decision', 'lesson', 'context', 'state', 'handoff'] as const;
const STATUSES = ['queued', 'running', 'success', 'error', 'timeout'] as const;
const SHELLS = ['bash', 'zsh', 'fish'] as const;

function bash(): string {
  return `# bash completion for relay
_relay_complete() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

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
    --workdir)   COMPREPLY=( \$(compgen -d -- "\$cur") ); return 0;;
    --rules-file|--spec) COMPREPLY=( \$(compgen -f -- "\$cur") ); return 0;;
  esac

  COMPREPLY=( \$(compgen -W "--json --provider --model --workdir --type --tag --pinned --token-budget --limit --status --max-concurrency --auto --quick --install --uninstall --rules-file --timeout-ms --reasoning-effort --check --apply --force --color --help" -- "\$cur") )
}
complete -F _relay_complete relay
`;
}

function zsh(): string {
  return `#compdef relay
# zsh completion for relay
_relay() {
  local -a commands memory_actions providers types statuses shells
  commands=(${COMMANDS.map(c => `'${c}:'`).join(' ')})
  memory_actions=(${MEMORY_ACTIONS.map(c => `'${c}:'`).join(' ')})
  providers=(${PROVIDERS.map(c => `'${c}:'`).join(' ')})
  types=(${MEMORY_TYPES.map(c => `'${c}:'`).join(' ')})
  statuses=(${STATUSES.map(c => `'${c}:'`).join(' ')})
  shells=(${SHELLS.map(c => `'${c}:'`).join(' ')})

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
    completion)
      if (( CURRENT == 3 )); then
        _describe -t shells 'shell' shells
        return
      fi
      ;;
  esac

  case "\${words[CURRENT-1]}" in
    --provider) _describe -t providers 'provider' providers; return;;
    --type)     _describe -t types 'memory type' types; return;;
    --status)   _describe -t statuses 'run status' statuses; return;;
    --workdir)  _path_files -/; return;;
    --rules-file|--spec) _files; return;;
  esac

  _arguments \\
    '--json[output JSON]' \\
    '--provider[provider]' \\
    '--model[model id]' \\
    '--workdir[workdir path]' \\
    '--type[memory type]' \\
    '--tag[tag (repeatable)]' \\
    '--pinned[mark pinned]' \\
    '--token-budget[token budget]' \\
    '--limit[limit]' \\
    '--status[status filter]' \\
    '--max-concurrency[concurrency]' \\
    '--timeout-ms[timeout in ms]' \\
    '--auto[non-interactive]' \\
    '--quick[bare init]' \\
    '--install[install hook]' \\
    '--uninstall[uninstall hook]' \\
    '--rules-file[rules file path]' \\
    '--reasoning-effort[codex reasoning effort]' \\
    '--check[check for updates only]' \\
    '--apply[pull, build, and test updates]' \\
    '--force[bypass signed-tag-ahead requirement]' \\
    '--color[auto|always|never]' \\
    '--help[show help]'
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
  for (const s of SHELLS) lines.push(`${cmd} -n '__fish_seen_subcommand_from completion' -a '${s}'`);
  lines.push(`${cmd} -l json -d 'output JSON'`);
  lines.push(`${cmd} -l provider -d 'provider' -xa '${PROVIDERS.join(' ')}'`);
  lines.push(`${cmd} -l type -d 'memory type' -xa '${MEMORY_TYPES.join(' ')}'`);
  lines.push(`${cmd} -l status -d 'run status' -xa '${STATUSES.join(' ')}'`);
  lines.push(`${cmd} -l workdir -d 'workdir path' -ra '(__fish_complete_directories)'`);
  lines.push(`${cmd} -l model -d 'model id'`);
  lines.push(`${cmd} -l tag -d 'tag (repeatable)'`);
  lines.push(`${cmd} -l pinned -d 'mark pinned'`);
  lines.push(`${cmd} -l token-budget -d 'token budget'`);
  lines.push(`${cmd} -l limit -d 'limit'`);
  lines.push(`${cmd} -l max-concurrency -d 'concurrency'`);
  lines.push(`${cmd} -l timeout-ms -d 'timeout in ms'`);
  lines.push(`${cmd} -l auto -d 'non-interactive init'`);
  lines.push(`${cmd} -l quick -d 'bare init'`);
  lines.push(`${cmd} -l install -d 'install hook'`);
  lines.push(`${cmd} -l uninstall -d 'uninstall hook'`);
  lines.push(`${cmd} -l rules-file -d 'rules file path' -r`);
  lines.push(`${cmd} -l reasoning-effort -d 'codex reasoning effort'`);
  lines.push(`${cmd} -l check -d 'check for updates only'`);
  lines.push(`${cmd} -l apply -d 'pull, build, and test updates'`);
  lines.push(`${cmd} -l force -d 'bypass signed-tag-ahead requirement'`);
  lines.push(`${cmd} -l color -d 'auto|always|never' -xa 'auto always never'`);
  lines.push(`${cmd} -l help -s h -d 'show help'`);
  lines.push(`${cmd} -l version -s V -d 'show version'`);
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
