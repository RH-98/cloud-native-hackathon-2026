// The browser account module's pure helpers: what gets saved and restored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySnapshot, canOptInProfile, isOwnGithubProfile, isSameLogin, prefillGithub, privateBannerText, snapshotState } from '../public/account.js';
import { derivedInterests, isPastedText, persistableRequest, saveInputs } from '../public/state.js';

const sample = () => ({
  request: { conferenceId: 'kubecon-na-2026', github: 'octocat', options: {} },
  profile: { source: 'github', username: 'octocat' },
  plan: { conferenceId: 'kubecon-na-2026', days: [{ date: '2026-11-10', slots: [] }] },
  pinned: new Set(['kubecon-na-2026:1']),
  skipped: new Set(['kubecon-na-2026:2']),
  swaps: new Map([['2026-11-10|x', 'kubecon-na-2026:3']]),
  activeDay: '2026-11-10',
});

test('snapshot round-trips through JSON into a fresh state', () => {
  const snap = JSON.parse(JSON.stringify(snapshotState(sample())));
  const s = { pinned: new Set(), skipped: new Set(), swaps: new Map() };
  assert.equal(applySnapshot(s, snap), true);
  assert.deepEqual([...s.pinned], ['kubecon-na-2026:1']);
  assert.deepEqual([...s.swaps], [['2026-11-10|x', 'kubecon-na-2026:3']]);
  assert.equal(s.plan.days.length, 1);
  assert.equal(s.activeDay, '2026-11-10');
});

test('snapshot without the plan, and nothing to restore', () => {
  assert.equal(snapshotState(sample(), { includePlan: false }).plan, null);
  assert.equal(applySnapshot({}, null), false);
  assert.equal(applySnapshot({}, { pinned: [] }), false);
});

test('only your own GitHub profile counts as yours', () => {
  const user = { login: 'OctoCat' };
  assert.equal(isOwnGithubProfile({ source: 'github', username: 'octocat' }, user), true);
  assert.equal(isOwnGithubProfile({ source: 'github+interests', username: 'octocat' }, user), true);
  assert.equal(isOwnGithubProfile({ source: 'github', username: 'torvalds' }, user), false);
  assert.equal(isOwnGithubProfile({ source: 'github+interests', username: 'torvalds' }, user), false);
  assert.equal(isOwnGithubProfile({ source: 'interests', username: null }, user), false);
  assert.equal(isOwnGithubProfile({ source: 'github', username: 'octocat' }, null), false);
});

test('saved blended profiles retain typed tools without copying GitHub-derived signals', () => {
  const s = sample();
  s.request = { ...s.request, interests: 'pasted profile '.repeat(40) };
  s.profile = {
    source: 'github+interests',
    tools: [
      { name: 'github-tool', label: 'GitHub tool', evidence: [{ repo: 'octocat/project' }] },
      { name: 'typed-tool', label: 'Typed tool', evidence: [] },
    ],
    languages: [{ name: 'Go' }],
    topics: ['GitHub topic', 'typed topic'],
    keywords: ['GitHub keyword', 'typed keyword'],
  };
  const saved = snapshotState(s);

  // Topics are kept in blended mode too (they are not weight-boosted); GitHub tools, languages and keywords are not.
  assert.equal(saved.request.interests, 'Typed tool, GitHub topic, typed topic');
  assert.equal(derivedInterests({ source: 'github', tools: [], languages: [{ name: 'Go' }], topics: ['cloud'], keywords: ['operators'] }), 'Go, cloud, operators');
});

test('short multi-line typed interests are preserved in local and account saves', () => {
  const interests = 'Kubernetes\nGitOps\nObservability\nPrometheus\nOpenTelemetry';
  let saved;
  assert.equal(isPastedText(interests), false);
  assert.equal(isPastedText('x'.repeat(500)), false);
  assert.equal(isPastedText('x'.repeat(501)), true);
  assert.equal(persistableRequest({ interests }, null).interests, interests);
  saveInputs({ interests }, { setItem: (_key, value) => { saved = JSON.parse(value); } });
  assert.equal(saved.interests, interests);
});

test('opt-in is offered for your own GitHub profile or an interests / LinkedIn-pasted one', () => {
  const user = { login: 'OctoCat' };
  assert.equal(canOptInProfile({ source: 'github+interests', username: 'octocat', pastedFrom: 'linkedin' }, user), true);
  assert.equal(canOptInProfile({ source: 'interests', username: null, pastedFrom: 'linkedin' }, user), true);
  assert.equal(canOptInProfile({ source: 'interests', username: null }, user), true);
  assert.equal(canOptInProfile({ source: 'github+interests', username: 'torvalds', pastedFrom: 'linkedin' }, user), false);
  assert.equal(canOptInProfile({ source: 'interests', username: 'torvalds' }, user), false);
  assert.equal(canOptInProfile({ source: 'interests', username: null }, null), false);
});

test('signing in fills an empty username field but keeps what was typed', () => {
  assert.equal(prefillGithub('', 'octocat'), 'octocat');
  assert.equal(prefillGithub('   ', 'octocat'), 'octocat');
  assert.equal(prefillGithub(undefined, 'octocat'), 'octocat');
  assert.equal(prefillGithub('torvalds', 'octocat'), 'torvalds');
  assert.equal(prefillGithub(' torvalds ', 'octocat'), 'torvalds');
  assert.equal(prefillGithub('', null), '');
});

test('the "Use @login" button hides only for your own login', () => {
  assert.equal(isSameLogin('OctoCat', 'octocat'), true);
  assert.equal(isSameLogin(' @octocat ', 'octocat'), true);
  assert.equal(isSameLogin('torvalds', 'octocat'), false);
  assert.equal(isSameLogin('', 'octocat'), false);
});

test('private-repo banner: plain messages for every outcome', () => {
  assert.equal(privateBannerText('ready', 3), '✓ Private repos added: 3 repos scanned. Your plan now includes them.');
  assert.equal(privateBannerText('ready', 1), '✓ Private repos added: 1 repo scanned. Your plan now includes them.');
  assert.match(privateBannerText('none'), /No private repos were granted.*GitHub settings/);
  assert.match(privateBannerText('mismatch'), /not the one you signed in with/);
  assert.match(privateBannerText('failed'), /Could not read your private repos/);
  assert.equal(privateBannerText('bogus'), null);
  assert.equal(privateBannerText('toString'), null);
});
