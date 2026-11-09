Apply fixes for leaked or logged secrets, missing OpenTelemetry spans or error recording on outbound calls, missing timeouts or rate-limit handling, accessibility problems (labels, alt text, keyboard access, contrast), and failing CI checks caused by the PR.

Don't apply fixes that change `deploy/kustomization.yaml` image lines, anything under `argocd/`, or `.github/workflows/deploy.yaml`. Those control deployment and need a human.

Don't apply fixes that change the app's HTTP routes or response shapes, or that delete user-visible features. Comment instead.
