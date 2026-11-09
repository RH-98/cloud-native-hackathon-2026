# Agent0 findings: conference-planner and conference-loader

Dash0 Agent0 ran one investigation on 2026-11-09, covering about 17:30 to 20:30 UTC (the last 3 hours). We asked it to assess the health and performance of service `conference-planner` and the `conference-loader` Job, and to point out errors, latency, noisy spans and missing resource attributes.

Thread: https://app.dash0.com/goto/agent0?thread_id=6062f121-f2f5-4696-9ddd-72c7a44a61b2&dataset=default&org=1c5491d7-7d87-48ac-8577-3a461cb09ac3

These findings are an AI's reading of our telemetry. We treat them as leads to verify, not as instructions. Nothing below was changed because of this investigation; the right-hand column says what we did about each finding.

## Summary

Both workloads are healthy: there are no real application errors and no latency problems. The problems are in the telemetry itself.

## conference-planner

| Finding (Agent0) | Evidence it gave | What we did |
|---|---|---|
| Healthy: no 5xx responses and no ERROR spans | 2,440 server spans. All 32 responses with status 404 were curl requests to `/does-not-exist`, which looks like a smoke test. User routes took at most 1.6 ms. | Nothing to fix |
| About 96% of spans are Kubernetes probes | `/readyz` 1,559, `/healthz` 779, curl 99, browser 3 | Fixed separately: PR #10 stops tracing health probes |
| Span names are a bare `GET` with no `http.route` | Dash0 falls back to the URL path | Noted |
| No outbound Elasticsearch spans yet | The only client spans are the cloud metadata detectors at startup, which get a 401 from `169.254.169.254` | The data was collected before the planner's Elasticsearch search shipped. Check again after deploy. The metadata detectors are noise. |
| `service.version` missing | 5 ReplicaSets rolled out in 65 minutes, and spans can't be told apart by version | Noted for the telemetry setup |
| Thin Kubernetes attributes | Only `k8s.namespace.name`, `k8s.pod.name` and `k8s.pod.uid` are set; `deployment.environment.name=hackathon` is present | Noted |

## conference-loader (Job)

| Finding (Agent0) | Evidence it gave | What we did |
|---|---|---|
| One run, which appears to have succeeded | 19:55:07 to 19:55:26 UTC. `es.ensure_indices` took 4.8 s and created 3 indices. `es.load_snapshot` took 13.9 s for 18 bulk batches. | Nothing to fix |
| Its "errors" are expected 404s | HEAD requests on the 3 indices and a GET of the meta document on a first load push the service catalog to 33% errors | Noted: mark expected 404s as non-errors |
| One run produces 3 separate traces | `es.ensure_indices`, an orphan root `get` and `es.load_snapshot` | Noted: wrap the run in one top-level `loader.run` span |
| 87 spans for one load | Each bulk call is three nested spans (`es.bulk` → `bulk` → `POST`), plus `dns`, `tcp` and `tls` spans | Noted |
| No `k8s.*` attributes, `deployment.environment` or `service.version` | Dash0 shows the Job as a `host` resource | Noted |
| No logs and no metrics | The Job exits before the periodic metric export runs | Noted: flush the SDK on shutdown |

## Suggested next step (Agent0)

Add `service.version` (from the git SHA) and `deployment.environment.name` to both services. Add the Kubernetes attributes, from the Downward API or from the collector's k8s attributes processor.
