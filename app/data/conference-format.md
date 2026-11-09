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
