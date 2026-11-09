# Contracts between the planner's parts

Several people (and agents) build the planner in parallel. This file fixes the shapes they share, so each part can be built and tested on its own. Change a shape here first, in its own PR, before changing code that depends on it.

## Flow

```
browser ──POST /api/plan──▶ server.js ──▶ profile.buildProfile()  ──▶ GitHub API
                                     └──▶ planner.buildPlan()     ──▶ search (Elasticsearch, or the snapshot offline)
```

## Profile (`app/profile/index.js`)

```js
const { buildProfile } = require('./profile');
const profile = await buildProfile({ github: 'octocat' });            // from public repos
const profile = await buildProfile({ interests: 'argo cd, otel, rust' }); // typed fallback
const profile = await buildProfile({ github: 'octocat', interests: 'rust, chess' }); // both: blended
```

Throws `ProfileError` (`err.code`: `not_found`, `rate_limited`, `upstream`, `invalid_input`). The GitHub token comes from `process.env.GITHUB_TOKEN` (Secret `app-credentials`, key `github-token`); without it, calls are unauthenticated (60 requests/hour).

```jsonc
{
  "source": "github",                 // github | interests | github+interests
  "username": "octocat",              // null for interests
  "displayName": "The Octocat",
  "avatarUrl": "https://…",           // null for interests
  "repoCount": 8,                     // repos scanned
  "languages": [{ "name": "Go", "weight": 0.6 }],            // weights 0..1, sorted desc
  "tools": [{ "name": "argo-cd", "label": "Argo CD", "weight": 0.9, "evidence": ["octocat/deploy"] }],
                                      // CNCF / infra tools from dependency files, manifests, topics, READMEs.
                                      // name: stable slug from the catalog in app/profile/tools.js; label: display name.
                                      // weight 0..1 (evidence strength: dependency/manifest > topic > README mention),
                                      // sorted desc, at most 15; evidence: up to 5 public repo full names
  "topics": ["kubernetes", "gitops"], // GitHub repo topics, lowercased
  "keywords": ["progressive delivery", "helm"], // from READMEs and descriptions
  "generatedAt": "2026-11-09T21:00:00Z"
}
```

Only derived signals are kept. Never store or return code, file contents or the token.

From `interests` (max 500 characters), phrases matching a catalog alias become tools (`"argo"` → `argo-cd`, `"otel"` → `opentelemetry`, `"k8s"` → `kubernetes`) with weight 1 and empty `evidence`; other phrases become `keywords`, and language names (`rust`, `golang`…) also fill `languages`. With both `github` and `interests`, the GitHub profile is built and the interests are blended in (`mergeInterests(profile, interestsProfile)`): typed tools and languages are added, or raised to weight `max(existing, 0.9)`, with empty `evidence`; unmatched phrases go first in `keywords` (deduped, at most 15); `source` is `github+interests`. GitHub profiles are cached in memory for 15 minutes per username. If GitHub rate-limits part-way through, the profile is built from what was already fetched (repo languages, topics, descriptions) rather than failing.

## Search and plan (`app/planner/index.js`)

```js
const { buildPlan } = require('./planner');
const plan = await buildPlan({ conferenceId: 'kubecon-na-2026', profile, options });
```

Uses Elasticsearch when `ELASTICSEARCH_URL` and `ELASTICSEARCH_API_KEY` are set, otherwise scores the snapshot in `app/data/conferences/` in memory, so the app runs locally with no credentials. All Elasticsearch queries live in `app/search/elasticsearch.js`.

`options` (all optional):

```jsonc
{
  "days": ["2026-11-10"],          // default: every day of the conference
  "levels": ["Beginner"],          // only these levels (plus "Any Level")
  "includeSponsored": true,
  "pinned": ["kubecon-na-2026:1335605"],  // always the pick in its slot
  "skipped": ["kubecon-na-2026:1340001"], // never suggested
  "firstTimer": false,             // accessibility options (Wave 2) go here too
  "breakMinutes": 0
}
```

Plan:

```jsonc
{
  "conferenceId": "kubecon-na-2026",
  "conference": { "name": "…", "timezone": "America/Denver", "utcOffset": "-07:00", "location": "…" },
  "generatedAt": "2026-11-09T21:00:00Z",
  "searchBackend": "elasticsearch",   // elasticsearch | snapshot
  "days": [
    {
      "date": "2026-11-10",
      "slots": [
        {
          "start": "2026-11-10T11:30:00-07:00",
          "end": "2026-11-10T12:00:00-07:00",
          "pick": Recommendation,        // or null when nothing fits (free time)
          "backups": [Recommendation],   // up to 2, overlapping the pick
          "pinned": false
        }
      ],
      "booths": [
        { "sponsor": Sponsor, "score": 0.7, "reasons": ["Uses argo-cd"], "gap": { "start": "…", "end": "…" } }
      ]
    }
  ]
}
```

A free slot (`pick: null`, any open stretch of 10 minutes or more between 9:00 and 18:00) also lists what you could do in it:

```jsonc
{
  "start": "2026-11-10T12:00:00-07:00", "end": "2026-11-10T13:00:00-07:00",
  "pick": null, "pinned": false,
  "backups": [Recommendation],  // up to 3 sessions on during the window, best match first even below the pick floor;
                                // reasons[0] is "Fits this window", "Starts in this window" or "Already running" (20+ min left),
                                // then any match reasons. No skipped sessions; sponsored demos only when nothing else is on.
                                // Empty for windows under 15 minutes.
  "booths": [{ "sponsor": Sponsor, "score": 0.7, "reasons": ["…"] }],
                                // on expo days: the day's booths for windows of 30+ min, one top match for 15-30 min
                                // (also listed in day.booths with this window as its gap)
  "logistics": [{ "title": "Lunch", "type": "meal", "start": "…", "end": "…", "room": "…" }],
                                // kind "logistics" items overlapping the window (type: meal | break | social | expo | other);
                                // titles lose leading emoji and ALL CAPS; all-day services (over 4 h) are left out
  "suggestion": "Lunch is served 12:20–2:20 PM MT in Halls A-C."  // one line for the window, times with the zone; "Short break: …" under 15 min
}
```

Free-slot options never export: the `.ics` file and "Copy plan as text" list only picks. "Add to plan" on a free-slot session pins it (re-requests with `options.pinned`); a pick it overlaps (or crowds within `breakMinutes`) drops out, and the UI names it in the announcement.

`Recommendation` is `{ "session": Session, "score": 0.83, "reasons": ["Matches argo-cd", "Beginner"] }`. `Session` and `Sponsor` are exactly the objects in [`app/data/conference-format.md`](../app/data/conference-format.md). `reasons` are short, human-readable strings the UI shows as-is.

## HTTP API (`app/server.js`)

| Route | Request | Response |
|---|---|---|
| `GET /healthz`, `GET /readyz` | | `ok` (keep these) |
| `GET /api/conferences` | | `{ "conferences": [{ id, name, location, timezone, startDate, endDate, sessionCount }] }` |
| `POST /api/plan` | `{ "conferenceId", "github"?: "user", "interests"?: "text", "options"?: {…} }` (at least one of `github` / `interests`; both blends them) | `{ "profile": Profile, "plan": Plan, "warnings"?: [code] }`. With both inputs, if GitHub answers `rate_limited`, `not_found` or `upstream`, the plan is built from the interests alone (`profile.source` is `interests`) and `warnings` holds `github_rate_limited`, `github_not_found` or `github_unavailable`. `warnings` is left out when empty |
| `POST /api/connections` | `{ "conferenceId", "profile": Profile, "pickedSessionIds"?: [id], "limit"?: 1-20, "firstTimer"?: bool }` | `{ "connections": [{ "attendee": { displayName, handle, role, bio, demo }, "score", "shared": [label], "why", "commonSessions": [{ id, title, start }] }], "searchBackend", "demoData": true }`. Opted-in attendees only: fictional demo attendees (`demo: true`) plus real users who signed in with GitHub and opted in (`demo: false`, never the requester); 404 when the conference has none |
| `GET /api/me` | cookie `sb_session` | `{ "enabled": bool, "user": { login, name, avatarUrl } \| null }` |
| `GET /api/me/plan?conferenceId=` | signed in | `{ "state": SavedState \| null, "savedAt" }`. SavedState: `{ request, pinned, skipped, swaps: [[slotKey, sessionId]], activeDay, plan, profile }` |
| `PUT /api/me/plan` | signed in, same origin; `{ "conferenceId", "state": SavedState }` (≤ 500 KB) | `{ "savedAt" }` |
| `GET /api/me/social?conferenceId=` | signed in | `{ "optedIn": bool, "optedInAt" }` |
| `PUT /api/me/social` | signed in, same origin; `{ "conferenceId", "optIn": bool, "profile"?: Profile }` | `{ "optedIn" }`. 403 unless `profile.source` is `github` or `github+interests` and `profile.username` is the signed-in login; stores derived signals only |
| `GET /auth/github/login?returnTo=/…`, `GET /auth/github/callback`, `POST /auth/logout` | | GitHub OAuth (scope `read:user`); the access token is never stored. Account errors: 401 `unauthorized`, 403 `forbidden`, 503 `unavailable` (database down) |
| `GET /api/changes` | query `conferenceId` (required), `since` (ISO 8601 date-time with a zone; only changes detected after it), `sessionIds` (comma-separated, max 200, all of this conference) | `{ "changes": [Change], "checkedAt": "…" \| null }`, newest first, at most 200 |
| `GET /` and static files | | the UI from `app/public/` |

Errors are JSON `{ "error": { "code": "not_found", "message": "No GitHub user named …" } }` with status 400 (`invalid_input`), 404 (`not_found`), 429 (`rate_limited`) or 502 (`upstream`).

`Change` is one document of the `conference-changes` index, written by the `schedule-watch` CronJob (`app/scripts/watch-schedule.js`). `checkedAt` is when that job last checked the conference; both are `null`/empty without Elasticsearch. An Elasticsearch failure answers 502 (`upstream`).

```jsonc
{
  "id": "kubecon-na-2026:1223002@2026-11-09T22:10:00.000Z",
  "conferenceId": "kubecon-na-2026",
  "sessionId": "kubecon-na-2026:1223002",
  "sessionTitle": "You Don’t Have to Choose: Argo and Flux Are Friends!",
  "type": "time_changed",          // time_changed | room_changed | cancelled | added | details_changed
  "before": { "start": "2026-11-10T14:50:00-07:00", "end": "2026-11-10T15:20:00-07:00", "room": "Salt Palace | Level 2 | 255 BC" }, // null for added
  "after":  { "start": "2026-11-10T16:20:00-07:00", "end": "2026-11-10T16:50:00-07:00", "room": "Salt Palace | Level 1 | Grand Ballroom BDF" }, // null for cancelled
  "detectedAt": "2026-11-09T22:10:00.000Z",
  "source": "simulated"            // live | simulated (ConfigMap schedule-overrides)
}
```

Plans apply recorded changes: sessions use their new time and room, and cancelled sessions are left out.

Pin, skip and swap happen in the browser: swap promotes a backup locally; pin and skip re-request `POST /api/plan` with `options.pinned` / `options.skipped`. The `.ics` calendar export is built in the browser from the plan.

## Who owns what (Wave 1)

| Part | Files | Notes |
|---|---|---|
| Profile | `app/profile/**`, `app/test/profile*.test.js`, `app/test/fixtures/github/**` | Replace the stub in `app/profile/index.js` |
| Search and planner | `app/planner/**`, search functions in `app/search/elasticsearch.js`, `app/test/planner*.test.js`, `app/test/search*.test.js` | Replace the stub in `app/planner/index.js` |
| API and UI | `app/server.js`, `app/api/**`, `app/public/**`, `app/test/api*.test.js`, `Dockerfile` if needed | Codes against the stubs |
| Cluster and telemetry | `deploy/**`, `STORY.md`, OpenTelemetry setup | |

Anything else (`README.md`, `app/package.json`, CI): small additions are fine; expect to rebase.
