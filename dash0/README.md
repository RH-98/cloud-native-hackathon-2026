# Dash0 as code

This folder holds the Dash0 assets for service `conference-planner`:

| File | What it is |
|---|---|
| `dashboard-conference-planner.json` | The "Conference Planner" dashboard, in the Perses `PersesDashboard` format that Dash0 dashboards use |
| `check-rules.yaml` | Four check rules (alerts), in the `PrometheusRule` format that Dash0 accepts |
| `agent0-findings.md` | Findings from a Dash0 Agent0 health investigation, with a link to its thread |

The custom metrics come from `app/metrics.js` (meter `conference-planner`). The HTTP panels use `http.server.request.duration`, which the Node auto-instrumentation produces.

## How Dash0 names things in PromQL

- Select a metric by its OpenTelemetry name: `{otel_metric_name="planner.plans", otel_metric_type="sum"}`. Dots in a bare PromQL metric name are a parse error.
- Attribute keys use underscores: `service.name` becomes `service_name`, `search.backend` becomes `search_backend`, `http.response.status_code` becomes `http_response_status_code`.
- Histograms are native histograms. Use `histogram_quantile(0.95, sum(rate({…}[5m])))` for percentiles and `histogram_count(rate({…}[5m]))` for request rates; there are no `_bucket` series.

We checked the query patterns against live `conference-planner` data with the Dash0 MCP `promql` tool: the HTTP histogram queries, `histogram_count`, and `last_over_time` on a live gauge. The `planner.*` series appear once the build with `app/metrics.js` is deployed and has served some plans.

`github.ratelimit.remaining` holds the `x-ratelimit-remaining` header from the latest api.github.com response (`app/profile/github.js`). Raw file fetches from raw.githubusercontent.com don't count against the API limit, so they're left out. The gauge stays empty until the first GitHub profile is built after a pod starts.

## Import the dashboard

1. In Dash0, open **Dashboards** and click **+ Add** to create a new dashboard.
2. Click **Edit as JSON** at the top right.
3. Replace the contents with `dashboard-conference-planner.json`, or upload the file, and click **Apply**. Then save the dashboard.

You can also use the CLI: `dash0 dashboards create -f dash0/dashboard-conference-planner.json`. Or use the Dash0 operator: apply the JSON as a `PersesDashboard` resource.

| Group | Panel | What it shows |
|---|---|---|
| Plans | Plan rate by outcome | Plans per second, by `outcome`: `ok`, `error` (our failure) or `rejected` (bad input: unknown conference or invalid options) |
| | Plan duration p50 / p95 | `planner.plan.duration`, the time to build one plan |
| | Plan p95 by search backend | The same, for Elasticsearch and for the in-memory snapshot |
| | Picks per plan | `planner.plan.picks`; a drop toward 0 means search stopped matching profiles |
| Search | Search backend share | Share of successful plans served by `elasticsearch` and by `snapshot` |
| | Search fallbacks to snapshot | `planner.search.fallbacks` by `reason`: `es_error` (Elasticsearch failed) or `no_credentials` (no `ELASTICSEARCH_*` env) |
| | Search latency p95 | `planner.search.duration` by `index` (sessions, sponsors) and `fusion`: `rrf` is the ES retriever, `js` is RRF fused in the app, `snapshot` is in memory, and sponsors use `none` |
| GitHub | Rate limit remaining | The latest `x-ratelimit-remaining` reported by the GitHub API (`github.ratelimit.remaining`) |
| HTTP | Request rate by status, 5xx error rate, latency p50/p95/p99 | RED metrics for the whole service, from `http.server.request.duration` |

## Import the check rules

1. In Dash0, open **Alerting**, then **Checks** (check rules), and create a new check rule.
2. Pick the PromQL/expression editor, and copy one rule's `expr` into it. Set the degraded and critical thresholds from its `dash0-threshold-*` annotations, and set "For" from `for`.
3. Repeat for the other rules. Or import the whole file at once with the CLI, which creates one check rule per alert: `dash0 apply -f dash0/check-rules.yaml`. The Dash0 operator syncs it too, if it's applied as a `PrometheusRule` in a monitored namespace.

Each rule's `$__threshold` is replaced by its degraded and critical values. Dash0 checks the critical value first.

| Check rule | Degraded | Critical | Meaning |
|---|---|---|---|
| Plan error ratio | > 2% | > 5% for 5m | Plans failing on our side. `rejected` doesn't count. |
| Plan p95 duration | > 3 s | > 5 s for 5m | Plans are slow. Look at search latency first. |
| Search falling back to snapshot | > 0 | > 5 per 5m, for 10m | Elasticsearch is degraded or its credentials are missing. Plans still work, but they come from the snapshot. |
| GitHub rate limit low | < 500 | < 100 | GitHub profile lookups will soon fall back to typed interests. Check `GITHUB_TOKEN`. |

## Suggested SLO

**99% of plans succeed in under 3 seconds**, over a rolling 7 days.

- Good events: plans with `outcome="ok"` that finished in under 3 s.
- Valid events: all plans with `outcome` = `ok` or `error`. `rejected` is the user's input, not our reliability.

```promql
# SLI: share of good plans (5m window; Dash0 SLOs aggregate it over the SLO period)
histogram_fraction(0, 3, sum(rate({otel_metric_name="planner.plan.duration", otel_metric_type="histogram", service_name="conference-planner"}[5m])))
* (
  sum(rate({otel_metric_name="planner.plans", otel_metric_type="sum", service_name="conference-planner", outcome="ok"}[5m]))
  / sum(rate({otel_metric_name="planner.plans", otel_metric_type="sum", service_name="conference-planner", outcome=~"ok|error"}[5m]))
)
```

`planner.plan.duration` records every plan, including failed ones. So the expression is an approximation: the fraction under 3 s times the success ratio. Create it under **SLOs** in Dash0, with a 99% target and a fast-burn alert at 14.4x the budget.
