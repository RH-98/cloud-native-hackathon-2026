# Review conventions for this project

This project builds a personal conference day planner. It reads a user's GitHub repos, matches them to KubeCon sessions and booths stored in Elasticsearch, and returns a day plan with backups. It runs on Kubernetes (Argo CD GitOps), sends OpenTelemetry data to Dash0, and the repo is public.

## Secrets and credentials (block the PR if any of these is violated)

- Never commit, log, print or return a token or key: GitHub tokens, Elasticsearch API keys, Dash0 auth tokens, kubeconfigs.
- Read credentials only from environment variables. In the cluster they come from the Kubernetes Secret `app-credentials`, referenced by name in `deploy/deployment.yaml`.
- Never put a credential in the Dockerfile, a build argument, a manifest value, a test fixture or an example.
- Error messages and logs must not include request headers or full upstream responses that could carry a token.

## User privacy

- From a user's repos, store and index only derived signals (languages, topics, dependency and tool names, short summaries). Never store or send repository source code.
- Never log the names or contents of a user's private repos.
- Suggested connections are opt-in. Only show other attendees who opted in, and only show shared public topics.

## Observability (Dash0 / OpenTelemetry)

- Every outbound call (GitHub API, Elasticsearch, any other HTTP service) runs inside an OpenTelemetry span with a clear name, for example `github.fetch_repos`, `es.search_sessions` or `plan.build`.
- Record errors on the span and set its status to error. Don't swallow exceptions silently.
- Span attributes and log fields must never contain tokens, emails or private repo names.

## Elasticsearch

- Keep all Elasticsearch queries in a single search module, not scattered through request handlers.
- Build queries with the client's query objects. Never concatenate user input into query strings.

## GitHub API

- Handle rate limits: check `x-ratelimit-remaining`, treat 403/429 as rate limiting, and degrade gracefully (cached data or the "type your interests" fallback) instead of failing the whole request.
- Set timeouts on every outbound request.

## Kubernetes contract

- The app listens on `$PORT` (8080) and keeps `/healthz` and `/readyz`.
- Never edit `newName` or `newTag` in `deploy/kustomization.yaml`; the GitHub Action owns them.
- Every new container or Job sets resource requests and limits, and the team's total is 2 CPU / 4 GiB of requests. No privileged, hostPath, hostNetwork or hostPID pods.

## Accessibility (part of how the project is judged)

- Use semantic HTML: real buttons and links, headings in order, lists for lists.
- Every form control has a label. Every meaningful image has alt text. Every interactive element works with the keyboard and has a visible focus style.
- Don't convey information by color alone. Keep text contrast at WCAG AA or better.
- Show session times with their time zone (Mountain Time) and in a format screen readers read clearly.

## Hackathon requirements

- The README must keep accurate setup instructions. If a PR adds an environment variable, dependency, service or deploy step, the README must be updated in the same PR.
- The README has an "AI usage" section disclosing AI-assisted work. Don't remove it.
