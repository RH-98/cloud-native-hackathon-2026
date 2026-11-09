---
title: "README stays in sync with setup"
description: "Hackathon submissions need accurate setup instructions and an AI usage disclosure"
type: check
when: "A pull request adds or changes environment variables, dependencies in app/package.json, the Dockerfile, files under deploy/ or argocd/, or a new service or Job"
actions: "Fail the check and comment listing which setup changes are missing from README.md"
---

# What to check

The hackathon requires a public repo with a README that has setup instructions, and it requires disclosing AI assistance.

1. Every environment variable the app reads is listed in the README, with what it's for and where it comes from (for example the `app-credentials` Secret). Never list a real value.
2. Every new dependency, service, Kubernetes Job or deploy step is covered in the setup instructions.
3. The README still has an "AI usage" section. Fail if a PR removes it.

Pull requests that only change app logic, tests, styles or text don't need README changes.
