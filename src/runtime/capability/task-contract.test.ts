/**
 * Unit tests for TaskContract inference and risk computation.
 *
 * Uses node:test + node:assert/strict — no external test framework.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { inferTaskContract, inferRisk, computeEffectiveRisk } from './task-contract.js';

// ---------------------------------------------------------------------------
// inferTaskContract — requirement inference
// ---------------------------------------------------------------------------

describe('inferTaskContract — requirement inference', () => {
  it('agentic task with workdir includes tool_use and file_read', () => {
    const contract = inferTaskContract({ isAgentic: true, workdir: '/some/path' });
    assert.ok(contract.requirements.has('tool_use'));
    assert.ok(contract.requirements.has('file_read'));
  });

  it('non-agentic task without workdir has empty requirements', () => {
    const contract = inferTaskContract({ isAgentic: false });
    assert.equal(contract.requirements.size, 0);
  });

  it('capabilities=[file_write] adds file_write', () => {
    const contract = inferTaskContract({ isAgentic: false, capabilities: ['file_write'] });
    assert.ok(contract.requirements.has('file_write'));
    assert.ok(!contract.requirements.has('commit'));
  });

  it('capabilities=[commit] adds both file_write and commit', () => {
    const contract = inferTaskContract({ isAgentic: false, capabilities: ['commit'] });
    assert.ok(contract.requirements.has('file_write'));
    assert.ok(contract.requirements.has('commit'));
  });

  it('capabilities=[grounding_required] adds grounding', () => {
    const contract = inferTaskContract({ isAgentic: false, capabilities: ['grounding_required'] });
    assert.ok(contract.requirements.has('grounding'));
  });

  it('images non-empty adds vision', () => {
    const contract = inferTaskContract({
      isAgentic: false,
      images: ['http://example.com/img.png'],
    });
    assert.ok(contract.requirements.has('vision'));
  });

  it('images empty does not add vision', () => {
    const contract = inferTaskContract({ isAgentic: false, images: [] });
    assert.ok(!contract.requirements.has('vision'));
  });

  it('passes risk_override and allow_fallback through to contract', () => {
    const contract = inferTaskContract({
      isAgentic: false,
      risk: 'critical',
      allow_fallback: true,
    });
    assert.equal(contract.risk_override, 'critical');
    assert.equal(contract.allow_fallback, true);
  });
});

// ---------------------------------------------------------------------------
// inferRisk — risk level from requirements
// ---------------------------------------------------------------------------

describe('inferRisk — risk inference from requirements', () => {
  it('empty requirements -> low', () => {
    assert.equal(inferRisk(new Set()), 'low');
  });

  it('tool_use only -> low', () => {
    assert.equal(inferRisk(new Set(['tool_use'])), 'low');
  });

  it('file_read only -> low', () => {
    assert.equal(inferRisk(new Set(['file_read'])), 'low');
  });

  it('file_write -> standard', () => {
    assert.equal(inferRisk(new Set(['file_write'])), 'standard');
  });

  it('file_write + commit -> standard', () => {
    assert.equal(inferRisk(new Set(['file_write', 'commit'])), 'standard');
  });

  it('grounding only -> critical', () => {
    assert.equal(inferRisk(new Set(['grounding'])), 'critical');
  });

  it('commit without explicit file_write -> standard', () => {
    // commit is standard (not critical) — reversible via git revert
    assert.equal(inferRisk(new Set(['commit'])), 'standard');
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveRisk — max(inferred, caller_override)
// ---------------------------------------------------------------------------

describe('computeEffectiveRisk — effective risk calculation', () => {
  it('caller override raises low to critical', () => {
    assert.equal(computeEffectiveRisk('low', 'critical'), 'critical');
  });

  it('critical inferred, low override -> stays critical', () => {
    assert.equal(computeEffectiveRisk('critical', 'low'), 'critical');
  });

  it('caller override raises low to standard', () => {
    assert.equal(computeEffectiveRisk('low', 'standard'), 'standard');
  });

  it('standard inferred, no override -> standard', () => {
    assert.equal(computeEffectiveRisk('standard'), 'standard');
  });

  it('no override defaults to low baseline', () => {
    assert.equal(computeEffectiveRisk('low'), 'low');
  });

  it('caller cannot lower critical to standard', () => {
    assert.equal(computeEffectiveRisk('critical', 'standard'), 'critical');
  });

  it('caller cannot lower critical to low', () => {
    assert.equal(computeEffectiveRisk('critical', 'low'), 'critical');
  });

  it('same level -> returns that level', () => {
    assert.equal(computeEffectiveRisk('standard', 'standard'), 'standard');
  });
});
