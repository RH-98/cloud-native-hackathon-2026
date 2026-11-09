# Conference data format

Every conference the planner knows about is one JSON file in `data/conferences/<conference-id>.json`. An importer converts each source (a Linux Foundation event page, and later Sessionize, Sched, or an organizer's upload) into this one format, so the rest of the app never depends on where the data came from.

```jsonc
{
  "conference": {
    "id": "kubecon-na-2026",            // stable, URL-safe
    "name": "KubeCon + CloudNativeCon North America 2026",
    "location": "Salt Palace Convention Center, Salt Lake City, Utah",
    "timezone": "America/Denver",       // IANA zone, for display
    "utcOffset": "-07:00",              // offset during the event
    "startDate": "2026-11-09",
    "endDate": "2026-11-12",
    "source": { "scheduleUrl": "...", "sponsorsUrl": "...", "retrievedAt": "2026-11-09T19:40:00Z" }
  },
  "sessions": [
    {
      "id": "kubecon-na-2026:1335605",  // <conference-id>:<source id>
      "conferenceId": "kubecon-na-2026",
      "sourceId": "1335605",
      "title": "SIG Instrumentation Introduction and Deep Dive",
      "description": "Plain text, paragraphs joined with spaces",
      "start": "2026-11-10T11:30:00-07:00", // ISO 8601 with offset
      "end": "2026-11-10T12:00:00-07:00",
      "room": "Salt Palace | Level 2 | 250 A-C",
      "speakers": ["Catherine Fang", "David Ashpole"],
      "track": "Maintainer Track",       // primary category, or null
      "level": "Any Level",              // Beginner | Intermediate | Advanced | Any Level | null
      "tags": ["Maintainer Track"],      // every label the source gives
      "sponsored": false,
      "kind": "session",                 // session | logistics (breaks, meals, coat check)
      "slidesAvailable": false,
      "url": "https://events.linuxfoundation.org/...?id=1335605"
    }
  ],
  "sponsors": [
    {
      "id": "kubecon-na-2026:akuity",
      "conferenceId": "kubecon-na-2026",
      "name": "Akuity",
      "tier": "Gold",                    // as the source names it, or null
      "url": "http://akuity.io"
    }
  ]
}
```

## Adding a conference

1. Write an importer in `importers/` that turns the source into the format above. Keep it a pure function (HTML or JSON in, objects out) and add a test with a small fixture in `test/fixtures/`.
2. Add a script in `scripts/` that fetches the source and writes `data/conferences/<id>.json`.
3. Commit the snapshot, so the app works without reaching the source at runtime.

## Conferences we have

| Id | Conference | Source | Importer | Rebuild |
|---|---|---|---|---|
| `kubecon-na-2026` | KubeCon + CloudNativeCon North America 2026, Nov 9–12, Salt Lake City | [LF schedule page](https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/) and sponsor list | `importers/lf-events.js` | `npm run import:kubecon` |
| `convergence-2026` | Convergence 2026 (Dynamics 365, Power Platform and Copilot), Dec 9–11, Fontainebleau Miami Beach | [Sessionize API](https://sessionize.com/api/v2/i9eggm8p/view/All) behind [the official sessions page](https://convergence365.com/sessions/), and [the sponsor page](https://convergence365.com/our-sponsors/) | `importers/sessionize.js`, `importers/sponsor-logos.js` | `npm run import:convergence` |

Session titles, descriptions and speaker names belong to each conference's organizers and speakers. Every session keeps a `url` back to the official schedule, and the UI links there. Convergence's Partner Pre-Day (Dec 8) is separately ticketed and has no sessions on the public schedule, so the snapshot covers Dec 9–11.

## Bring your own conference (Sessionize)

Any event whose schedule is on [Sessionize](https://sessionize.com) can be imported with `importers/sessionize.js`:

1. The organizer opens **API / Embed** in their Sessionize event, enables the **All Data** JSON endpoint, and shares its id (the `<id>` in `https://sessionize.com/api/v2/<id>/view/All`). Public schedule pages that embed Sessionize show the same id in their embed script URL.
2. Copy `scripts/import-convergence-2026.js` to `scripts/import-<conference-id>.js` and change `SESSIONIZE_ID`, the `conference` metadata (an IANA `timezone` and the `utcOffset` in effect during the event: Sessionize times are local, without an offset) and the session/sponsor page URLs. Set `sponsors` to `[]` if the event has no sponsor page in the shape `importers/sponsor-logos.js` reads (tier headings followed by linked logos).
3. Optionally pick `trackCategory`: the Sessionize category titles to take each session's track from, in order. Without it, a category titled "Track" is used, else the first session category.
4. Run it (`node scripts/import-<conference-id>.js`), commit `data/conferences/<conference-id>.json`, and run the Elasticsearch load Job again. The loader only loads snapshots it hasn't seen.

How Sessionize maps onto this format:

| Sessionize | Here |
|---|---|
| `startsAt` / `endsAt` (local) | `start` / `end` with the conference's `utcOffset`. Sessions with no time slot are left out |
| `roomId` → `rooms[].name` | `room` |
| `speakers` → `speakers[].fullName` | `speakers` |
| Every session category item | `tags`. The chosen track category gives `track`, a category titled "Level" gives `level` (Introductory → Beginner, Expert → Advanced, …) |
| `isServiceSession` (breaks, meals, expo hours) | `kind: "logistics"`, except titles matching "keynote", which stay sessions with track `Keynote` so the planner treats them as keynotes |
| A tag containing "sponsor" | `sponsored: true` |
