import test from 'node:test';
import assert from 'node:assert/strict';
import { isPastedText, persistableRequest, saveInputs } from '../public/state.js';
import { snapshotState } from '../public/account.js';

const paste = `Avery Quill\nSenior Platform Engineer\n500+ connections\nAbout\nI build platforms.\nSkills\nKubernetes\n${'x'.repeat(600)}`;
const profile = {
  source: 'interests', pastedFrom: 'linkedin',
  tools: [{ name: 'kubernetes', label: 'Kubernetes', weight: 1, evidence: [] }],
  languages: [{ name: 'Go', weight: 1 }], topics: ['platform engineering'], keywords: ['aws'],
};

test('a pasted profile is never saved to localStorage', () => {
  const stored = {};
  const storage = { setItem: (k, v) => { stored[k] = v; } };
  saveInputs({ github: 'octo-dev', interests: paste }, storage);
  const saved = Object.values(stored).join('');
  assert.ok(!saved.includes('Avery') && !saved.includes('platforms'));
  assert.ok(saved.includes('octo-dev'));
  saveInputs({ interests: 'rust, chess' }, storage);
  assert.ok(Object.values(stored).join('').includes('rust, chess'));
});

test('a saved account plan keeps the derived signals, not the paste', () => {
  assert.equal(isPastedText('argo cd, otel'), false);
  assert.equal(isPastedText(paste), true);
  const snap = snapshotState({
    request: { conferenceId: 'kubecon-na-2026', interests: paste }, pinned: new Set(), skipped: new Set(),
    swaps: new Map(), activeDay: null, plan: null, profile,
  });
  assert.equal(snap.request.interests, 'Kubernetes, Go, platform engineering, aws');
  assert.ok(!JSON.stringify(snap).includes('Avery'));
  const typed = { conferenceId: 'kubecon-na-2026', interests: 'rust' };
  assert.equal(persistableRequest(typed, profile), typed);
});
