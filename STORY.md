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

- 12:55 PM: we created the one-off Job `load-elasticsearch-001` through Radar's MCP server (`apply_resource`, mode=create) with image `a3ecd54`. It created the Elasticsearch indices and indexed 845 documents (600 KubeCon sessions, 244 sponsors, 1 conference record) in 13.9s, and Radar showed it Complete about 30s after creation. Its traces go to Dash0 as `conference-loader`.
- Hardening PR: fixed the 4 Checks findings on `Deployment/app` in git (no service account token, read-only root filesystem with a 64Mi `/tmp` emptyDir, PodDisruptionBudget `app` with `minAvailable: 1`, topology spread across nodes with `ScheduleAnyway`). Telemetry: `app/telemetry.js` replaces the auto-instrumentation register hook, so the `/healthz` and `/readyz` probes no longer send spans to Dash0, the cloud resource detectors are off, and spans carry `service.version` from `APP_VERSION`.
- 1:57 PM: Job `load-attendees-001` (created through Radar) created index `conference-attendees` and indexed 64 fictional demo attendees in 4.9s, for suggested connections.
- 2:15 PM, incident: deploys stopped. Radar showed Argo CD's Application `app` with `ComparisonError` ("connection refused" to the repo-server on port 8081), and the pre-installed `argocd/argocd-repo-server` in `CrashLoopBackOff` with 23 restarts, exit code 143. Radar's events showed the cause of the restarts: its liveness probe on `/healthz` (port 8084) timed out, so kubelet killed it about 34s after each start. Radar's metrics ruled out resources: about 0.002 cores and 25 MiB against a 512 MiB limit. Three merged PRs (#14, #16, #18) were built but couldn't deploy. The repo-server belongs to the platform, so we didn't touch it.
- 2:23 PM: we started a Radar AI investigation on `argocd-repo-server` ([run](https://app.radarhq.io/c/k8acMtt3p7U/investigations/chat_f5PguO3y7bSBoNfD?org=org_NCJbssDGEBsU)). Its finding (confidence 0.62): the container is SIGTERM-killed by intermittently stalling `/healthz` probes, starting around 12:48 PM. It ruled out CPU/memory starvation, a Redis failure and a bad rollout (no spec, image or env change), and said the stall's trigger needs the previous container's logs from the next crash. Suggested mitigation, only if those logs show a busy rather than hung process: loosen the probe timeout and failure threshold.
- 2:26 PM: the repo-server stayed up after its 24th restart. We synced through Radar right away, and #14, #16 and #18 went live together. Job `load-elasticsearch-002` (created through Radar) then loaded the second conference, Convergence 2026 (230 documents in 4.7s), and skipped KubeCon, which was already loaded.
- Accounts PR: Postgres for saved plans comes from the CloudNativePG operator already in the cluster, as a one-instance `Cluster` (`deploy/postgres.yaml`) shipped through GitOps like the app; the app reads Secret `db-app` and migrates its tables on start.
- Live schedule updates: the CronJob `schedule-watch` (in git, synced by Argo CD) re-checks the KubeCon schedule every 10 minutes, records moved, re-roomed and cancelled sessions in Elasticsearch, and the UI flags affected picks with a one-click fix. For the demo, ConfigMap `schedule-overrides` simulates a change and Radar's `manage_cronjob` runs the job on demand.

## After

Recorded Monday, November 9, 2026 at 1:47 PM MST, after the hardening PR (#10, `f67bf53`) and later deploys up to `b7f9e69` synced through Argo CD.

Checks: https://app.radarhq.io/checks?scope=k8acMtt3p7U&namespace=team-ryan-hilton-real

0 findings: 0 critical, 0 high, 0 medium, 0 low (down from 4 medium at 11:37 AM). All four fixes landed in git and deployed through GitOps, with no changes applied by hand.
