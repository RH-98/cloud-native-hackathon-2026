# Our day with Radar

## Before

Recorded Monday, November 9, 2026 at 11:37 AM MST, right after the first GitOps deploy of `658246d`.

Checks: https://app.radarhq.io/checks?scope=k8acMtt3p7U&namespace=team-ryan-hilton-real

4 findings: 0 critical, 0 high, 4 medium, 0 low.

- Medium (Security): `automountServiceAccountToken` on `Deployment/app`. The service account token is mounted automatically.
- Medium (Security): `readOnlyRootFs` on `Deployment/app`. Container `app` does not use a read-only root filesystem.
- Medium (Reliability): `missingPDB` on `Deployment/app`. The deployment has 2 replicas but no PodDisruptionBudget.
- Medium (Reliability): `missingTopologySpread` on `Deployment/app`. The deployment has 2 replicas but no topology spread constraints.

## Notes from setup

- 11:24: we applied the Argo CD Application through Radar's MCP server. It stayed without a status for about 9 minutes.
- Radar showed crash loops in platform namespaces (argo-rollouts, cnpg-system, monitoring), failed Checks requests, and intermittent `Unauthorized` from MCP calls.
- Radar's log view of `argocd-application-controller-0` showed `connection refused` to the vcluster API server at 18:32 UTC. Argo CD reconciled at 18:33:35 UTC, about a minute later, and synced `a1b88d8`.
- 11:37: the URL served `version 658246d`. The platform had a short API-server interruption, not an ongoing outage, so we didn't change anything.

## During the day

- 1:55 PM: we created the one-off Job `load-elasticsearch-001` through Radar's MCP server (`apply_resource`, mode=create) with image `a3ecd54`. It created the Elasticsearch indices and indexed 845 documents (600 KubeCon sessions, 244 sponsors, 1 conference record) in 13.9s, and Radar showed it Complete about 30s after creation. Its traces go to Dash0 as `conference-loader`.
- Hardening PR: fixed the 4 Checks findings on `Deployment/app` in git (no service account token, read-only root filesystem with a 64Mi `/tmp` emptyDir, PodDisruptionBudget `app` with `minAvailable: 1`, topology spread across nodes with `ScheduleAnyway`). Telemetry: `app/telemetry.js` replaces the auto-instrumentation register hook, so the `/healthz` and `/readyz` probes no longer send spans to Dash0, the cloud resource detectors are off, and spans carry `service.version` from `APP_VERSION`.

## After

TODO after deploy
