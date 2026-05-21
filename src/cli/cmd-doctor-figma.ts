/**
 * Phase 7 / Task 6 — relay doctor --figma probe.
 *
 * Honest design: probe `GET /v1/me` ONLY (plan-tier inference from /v1/me is
 * not reliable per VERIFICATION.md W1 — Figma's response shape doesn't surface
 * `plan` consistently). Users wanting Enterprise-tier verification can run an
 * update_token attempt; this probe surfaces PAT validity + REST reachability.
 *
 * Outputs:
 *   - PAT: present | absent (with actionable hint when absent)
 *   - REST: ok | failed | skipped
 *   - User: <handle> (<id>) when /v1/me succeeded
 *   - Deferred (v0.3): figma_get_selection, figma_create_component
 *     (read from DEFERRED_FIGMA_TOOLS const — never hardcoded)
 *
 * All output passes through scrubPat as defense-in-depth (T-07-10).
 */

import { loadPat } from '../tools/figma/pat-loader.js';
import { figmaGet, FigmaForbiddenError, FigmaApiError, type FetchFn } from '../tools/figma/rest-client.js';
import { scrubPat } from '../tools/figma/scrub.js';
import { DEFERRED_FIGMA_TOOLS } from '../tools/figma/index.js';

export type FigmaProbeRestStatus = 'ok' | 'failed' | 'skipped';

export interface FigmaProbeResult {
  patPresent: boolean;
  restStatus: FigmaProbeRestStatus;
  restDetail: string;
  user: string | null;
}

export interface FigmaProbeOpts {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  fetchImpl?: FetchFn;
}

/**
 * Probe Figma reachability. Pure: never writes to stdout; caller renders via
 * formatFigmaProbeOutput (or composes into wider doctor output).
 */
export async function probeFigma(opts: FigmaProbeOpts): Promise<FigmaProbeResult> {
  const pat = loadPat(opts.env, opts.homeDir);
  if (!pat) {
    return {
      patPresent: false,
      restStatus: 'skipped',
      restDetail: 'no PAT to probe',
      user: null,
    };
  }

  try {
    const response = (await figmaGet('/v1/me', {
      pat,
      fetchImpl: opts.fetchImpl,
    })) as { id?: string; email?: string; handle?: string };
    const id = response.id ?? '?';
    const handle = response.handle ?? response.email ?? 'unknown';
    return {
      patPresent: true,
      restStatus: 'ok',
      restDetail: 'reachable',
      user: `${handle} (${id})`,
    };
  } catch (err) {
    let detail = 'unknown error';
    if (err instanceof FigmaForbiddenError) {
      detail = `${err.kind} (${err.status})`;
    } else if (err instanceof FigmaApiError) {
      detail = `HTTP ${err.status}`;
    } else if (err instanceof Error) {
      detail = err.message;
    }
    return {
      patPresent: true,
      restStatus: 'failed',
      restDetail: scrubPat(detail),
      user: null,
    };
  }
}

/**
 * Render a FigmaProbeResult as multi-line stdout text suitable for `relay
 * doctor --figma`. Always includes the deferred-tools notice — read from
 * DEFERRED_FIGMA_TOOLS const so changing the const propagates here.
 */
export function formatFigmaProbeOutput(result: FigmaProbeResult): string {
  const lines: string[] = [];
  lines.push('relay doctor --figma');
  lines.push('');
  if (result.patPresent) {
    lines.push('PAT:       present');
  } else {
    lines.push('PAT:       absent (set FIGMA_API_TOKEN or write ~/.relay/secrets/figma.json chmod 600)');
  }
  if (result.restStatus === 'ok') {
    lines.push(`REST:      ok (${scrubPat(result.restDetail)})`);
    if (result.user) lines.push(`User:      ${scrubPat(result.user)}`);
  } else if (result.restStatus === 'failed') {
    lines.push(`REST:      failed (${scrubPat(result.restDetail)})`);
  } else {
    lines.push(`REST:      skipped (${scrubPat(result.restDetail)})`);
  }
  lines.push('');
  // FIGMA-05 declarative deferral — names come from the const.
  lines.push(
    `Deferred to v0.3 (require Figma Plugin API bridge): ${DEFERRED_FIGMA_TOOLS.join(', ')}`,
  );
  return lines.join('\n') + '\n';
}
