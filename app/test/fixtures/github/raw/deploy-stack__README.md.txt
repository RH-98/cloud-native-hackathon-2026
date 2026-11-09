# deploy-stack

[![CI](https://github.com/octo-dev/deploy-stack/actions/workflows/ci.yml/badge.svg)](https://github.com/octo-dev/deploy-stack/actions)

GitOps platform for progressive delivery on Kubernetes. Argo CD syncs the
manifests; canary analysis runs against Prometheus metrics.

```sh
kubectl apply -k deploy/
SECRET_SHOULD_NEVER_APPEAR=abc
```

Progressive delivery with canary analysis keeps releases safe.
