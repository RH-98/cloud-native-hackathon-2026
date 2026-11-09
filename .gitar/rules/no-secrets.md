---
title: "No secrets in the public repo"
description: "Fail the PR if it adds anything that looks like a credential, kubeconfig or env file"
type: check
when: "Any pull request that adds or changes files"
actions: "Fail the check and comment on the exact lines, explaining how to move the value into the app-credentials Kubernetes Secret instead"
---

# What to check

This repo and its container image are public, so a leaked credential is exposed immediately.

Fail the check if the diff adds any of these:

1. A value that looks like an API key or token: GitHub tokens (`ghp_`, `gho_`, `github_pat_`), Elasticsearch API keys, Dash0 auth tokens, bearer tokens, private keys (`-----BEGIN ... PRIVATE KEY-----`).
2. A kubeconfig, or any file with `client-certificate-data`, `client-key-data` or a `token:` field for a cluster.
3. A `.env` file or other env file with real values. `.env.example` with placeholder values is fine.
4. A credential passed as a Docker build argument or written into a manifest under `deploy/` or `argocd/` (only `secretKeyRef` references to `app-credentials` are allowed).

Placeholders such as `YOUR_TOKEN`, `<api-key>` or `changeme` are fine.
