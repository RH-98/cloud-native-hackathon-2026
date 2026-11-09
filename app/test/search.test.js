const test = require('node:test');
const assert = require('node:assert/strict');
const es = require('../search/elasticsearch');
const terms = require('../planner/terms');
const snapshotSearch = require('../planner/snapshot-search');

const profile = {
  tools: [
    { name: 'argo-cd', label: 'Argo CD', weight: 0.9, evidence: [] },
    { name: 'opentelemetry', weight: 0.6, evidence: [] },
    { name: 'kubernetes', weight: 1, evidence: [] },
  ],
  topics: ['gitops'],
  keywords: ['progressive delivery'],
  languages: [{ name: 'Go', weight: 0.7 }, { name: 'Rust', weight: 0.3 }],
};

const session = (id, extra = {}) => ({
  id,
  conferenceId: 'kubecon-na-2026',
  title: 'A talk',
  description: '',
  start: '2026-11-10T11:30:00-07:00',
  end: '2026-11-10T12:00:00-07:00',
  tags: [],
  track: null,
  level: null,
  kind: 'session',
  ...extra,
});

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    async search(req, transport) {
      calls.push({ req, transport });
      return respond(req, calls.length);
    },
  };
}

// Every string in a request body, with the key it sits under.
function strings(value, key = null, out = []) {
  if (typeof value === 'string') out.push({ key, value });
  else if (Array.isArray(value)) value.forEach((v) => strings(v, key, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, k, out);
  return out;
}

test('profileTerms: labels, dashes as spaces, generic terms damped, risky languages left out', () => {
  const t = terms.profileTerms(profile);
  const byKey = Object.fromEntries(t.map((x) => [x.key, x]));
  assert.equal(byKey['argo cd'].label, 'Argo CD');
  assert.equal(byKey.opentelemetry.label, 'opentelemetry');
  assert.ok(byKey.kubernetes.weight < byKey.opentelemetry.weight);
  assert.ok(!byKey.go, 'Go is too ambiguous to match as a word');
  assert.ok(byKey.rust);
  assert.deepEqual(byKey['argo cd'].variants, ['argo cd', 'argocd']);
});

test('cloud native and native topics are retained, with cloud native down-weighted as generic', () => {
  const byKey = Object.fromEntries(terms.profileTerms({ topics: ['cloud native', 'native'] }).map((x) => [x.key, x]));
  assert.equal(byKey['cloud native'].generic, true);
  assert.equal(byKey['cloud native'].weight, 0.09);
  assert.equal(byKey.native.generic, false);
  assert.equal(byKey.native.weight, 0.6);
});

test('buildSessionSearch: an RRF retriever over a lexical and a semantic retriever, with filters', () => {
  const { request, lexical, semantic } = es.buildSessionSearch({
    conferenceId: 'kubecon-na-2026',
    profile,
    days: ['2026-11-10', '2026-11-12'],
    levels: ['Beginner'],
    size: 250,
    utcOffset: '-07:00',
  });
  assert.equal(request.index, 'conference-sessions');
  assert.equal(request.size, 250);
  const { rrf } = request.retriever;
  assert.equal(rrf.rank_window_size, 250);
  assert.deepEqual(rrf.retrievers, [{ standard: { query: lexical } }, { standard: { query: semantic } }]);

  const mm = lexical.bool.should.map((c) => c.multi_match);
  const argo = mm.find((m) => m.query === 'argo cd');
  assert.deepEqual(argo.fields, ['title^3', 'description', 'tags^2', 'track']);
  assert.equal(argo.boost, 0.9);
  assert.ok(mm.some((m) => m.query === 'argocd'));
  assert.equal(lexical.bool.minimum_should_match, 1);

  const sem = semantic.bool.must[0].semantic;
  assert.equal(sem.field, 'semantic');
  assert.match(sem.query, /Argo CD/);
  assert.match(sem.query, /opentelemetry/);

  for (const q of [lexical, semantic]) {
    const f = q.bool.filter;
    assert.deepEqual(f[0], { term: { conferenceId: 'kubecon-na-2026' } });
    assert.deepEqual(f[1], { term: { kind: 'session' } });
    assert.deepEqual(f[2].bool.should[1], {
      range: { start: { gte: '2026-11-12T00:00:00-07:00', lte: '2026-11-12T23:59:59-07:00' } },
    });
    assert.deepEqual(f[3].bool.should[0], { terms: { level: ['Beginner', 'Any Level'] } });
    assert.deepEqual(f[3].bool.should[1], { bool: { must_not: { exists: { field: 'level' } } } });
  }
});

test('buildSessionSearch: user input only ever lands in query values', () => {
  const evil = 'x" OR *:* ) { "match_all"';
  const { request } = es.buildSessionSearch({
    conferenceId: 'kubecon-na-2026',
    profile: { tools: [{ name: evil, weight: 1 }], topics: [], keywords: [], languages: [] },
  });
  const hits = strings(request).filter((s) => s.value.includes('match_all'));
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(h.key, 'query');
  assert.ok(!('query_string' in JSON.parse(JSON.stringify(request))));
});

test('searchSessions: sends the RRF request and returns scored, explained recommendations', async () => {
  const client = fakeClient(() => ({
    hits: {
      hits: [
        { _id: 'a', _score: 2 / 61, _source: session('a', { title: 'Argo CD at scale', level: 'Beginner', semantic: 'x' }) },
        { _id: 'b', _score: 1 / 62, _source: session('b', { title: 'Shipping safely', description: 'Canaries and more' }) },
      ],
    },
  }));
  const recs = await es.searchSessions(client, { conferenceId: 'kubecon-na-2026', profile, size: 100 });
  assert.equal(client.calls.length, 1);
  assert.ok(client.calls[0].req.retriever.rrf);
  assert.ok(client.calls[0].transport.requestTimeout > 0);
  assert.deepEqual(recs.map((r) => r.session.id), ['a', 'b']);
  assert.deepEqual(recs[0].reasons, ['Matches Argo CD', 'Beginner friendly']);
  assert.ok(!('semantic' in recs[0].session));
  assert.deepEqual(recs[1].reasons, ['Similar to your work']);
  assert.ok(recs[0].score > recs[1].score && recs[1].score > 0 && recs[0].score <= 1);
});

test('searchSessions: falls back to two searches fused in JS when RRF is rejected', async () => {
  const client = fakeClient((req, n) => {
    if (n === 1) {
      const err = new Error('parsing_exception: unknown retriever [rrf]');
      err.meta = { statusCode: 400 };
      throw err;
    }
    const lexical = 'should' in req.query.bool;
    return {
      hits: {
        hits: lexical
          ? [{ _id: 'a', _source: session('a', { title: 'Argo CD' }) }, { _id: 'b', _source: session('b') }]
          : [{ _id: 'c', _source: session('c') }, { _id: 'a', _source: session('a', { title: 'Argo CD' }) }],
      },
    };
  });
  const recs = await es.searchSessions(client, { conferenceId: 'kubecon-na-2026', profile });
  assert.equal(client.calls.length, 3);
  assert.ok(client.calls[1].req.query && !client.calls[1].req.retriever);
  assert.deepEqual(recs.map((r) => r.session.id).sort(), ['a', 'b', 'c']);
  assert.equal(recs[0].session.id, 'a');
});

test('searchSessions: other errors propagate so the planner can fall back', async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error('socket hang up'), { meta: { statusCode: 503 } });
  });
  await assert.rejects(es.searchSessions(client, { conferenceId: 'kubecon-na-2026', profile }), /socket hang up/);
  assert.equal(client.calls.length, 1);
});

test('fuseRrf: documents in both lists rank first, ties by id', () => {
  const fused = es.fuseRrf([
    [{ _id: 'x' }, { _id: 'y' }],
    [{ _id: 'y' }, { _id: 'z' }],
  ]);
  assert.deepEqual(fused.map((h) => h._id), ['y', 'x', 'z']);
  assert.equal(fused[0]._score, 1 / 62 + 1 / 61);
  assert.equal(es.fuseRrf([[{ _id: 'a' }, { _id: 'b' }]], { size: 1 }).length, 1);
});

test('searchSponsors: asks for matching names and known vendors, ranks by match then tier', async () => {
  const client = fakeClient(() => ({
    hits: {
      hits: [
        { _source: { id: 's:aws', name: 'AWS', tier: 'Diamond' } },
        { _source: { id: 's:akuity', name: 'Akuity', tier: 'Gold' } },
        { _source: { id: 's:dash0', name: 'Dash0', tier: 'Silver' } },
        { _source: { id: 's:datadog', name: 'Datadog', tier: 'Platinum' } },
      ],
    },
  }));
  const ranked = await es.searchSponsors(client, { conferenceId: 'kubecon-na-2026', profile });
  const { req } = client.calls[0];
  assert.equal(req.index, 'conference-sponsors');
  assert.deepEqual(req.query.bool.filter, [{ term: { conferenceId: 'kubecon-na-2026' } }]);
  const vendors = req.query.bool.should.find((c) => c.terms).terms['name.keyword'];
  assert.ok(vendors.includes('Akuity') && vendors.includes('Dash0'));
  assert.deepEqual(ranked.map((r) => r.sponsor.name), ['Akuity', 'Datadog', 'Dash0', 'AWS']);
  assert.deepEqual(ranked[0].reasons, ['Works with Argo CD']);

  const empty = fakeClient(() => assert.fail('no search without terms'));
  assert.deepEqual(await es.searchSponsors(empty, { conferenceId: 'k', profile: {} }), []);
});

test('scoreSponsor: a sponsor named after a tool says so', () => {
  const t = terms.profileTerms({ tools: [{ name: 'docker', weight: 1 }] });
  assert.deepEqual(terms.scoreSponsor({ name: 'Docker' }, t).reasons, ['Makes docker']);
  assert.equal(terms.scoreSponsor({ name: 'Unrelated Inc' }, t), null);
});

test('searchAvailable needs both the URL and the API key', () => {
  assert.equal(es.searchAvailable({}), false);
  assert.equal(es.searchAvailable({ ELASTICSEARCH_URL: 'https://x' }), false);
  assert.equal(es.searchAvailable({ ELASTICSEARCH_URL: 'https://x', ELASTICSEARCH_API_KEY: 'k' }), true);
});

test('snapshot search: weighted term overlap, deterministic, with filters', () => {
  const snapshot = {
    sessions: [
      session('t1', { title: 'Argo CD and OpenTelemetry', level: 'Advanced' }),
      session('t2', { description: 'We use argocd for gitops' }),
      session('t3', { title: 'Unrelated' }),
      session('t4', { title: 'Argo CD', start: '2026-11-11T10:00:00-07:00', end: '2026-11-11T10:30:00-07:00' }),
      session('t5', { title: 'Argo CD lunch', kind: 'logistics' }),
    ],
  };
  const recs = snapshotSearch.searchSessions(snapshot, { profile, days: ['2026-11-10'] });
  assert.deepEqual(recs.map((r) => r.session.id), ['t1', 't2']);
  assert.deepEqual(recs[0].reasons, ['Matches Argo CD', 'Matches opentelemetry', 'Advanced level']);
  assert.deepEqual(recs[1].reasons, ['Matches Argo CD', 'Matches gitops']);
  assert.deepEqual(snapshotSearch.searchSessions(snapshot, { profile, days: ['2026-11-10'] }), recs);
  const beginners = snapshotSearch.searchSessions(snapshot, { profile, levels: ['Beginner'] });
  assert.ok(!beginners.some((r) => r.session.id === 't1'));
});
