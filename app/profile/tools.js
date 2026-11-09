// Catalog of cloud-native / infra tools and the evidence that points at each.
// Pure: no network, no I/O. Detection works on derived signals only
// (dependency names, file paths, manifest apiVersion/kind, image names,
// topics, lowercased description/README text); never on stored code.
//
// Each entry:
//   name      slug used in profiles and by the planner
//   label     display name; the planner also matches it against session text,
//             so use the name talks use ("Kafka", not "Apache Kafka")
//   aliases   what people type or tag (interests, GitHub topics); also README
//             mentions unless `mentions` is given
//   mentions  phrases that count as a README/description mention (optional)
//   deps      "<ecosystem>:<package>" patterns, `*` suffix = prefix match.
//             Ecosystems: npm, go, pypi, cargo, helm (Chart.yaml dependencies),
//             action (GitHub Actions `uses:`)
//   files     regexes on repo-relative paths (from the git tree)
//   groups    manifest API groups (exact or as a parent domain), `group/Kind`
//             to pin a kind
//   images    container image patterns (full path suffix or last segment, `*` prefix)
//   implies   other tools this one's strong evidence also counts for
//   common    true for tools nearly every repo has (CI, Dockerfiles); their
//             profile weight is damped so specific tools rank above them

const STRENGTH = { strong: 3, topic: 2, implied: 1.5, mention: 1 };

// Evidence kinds. Strong kinds are real usage (a dependency, a manifest, a
// workflow step, a container image); the rest are interest or prose.
//   dependency  package manifests (package.json, go.mod, Chart.yaml deps…)
//   manifest    Kubernetes apiVersion/kind, or a tool's config file in the tree
//   workflow    GitHub Actions `uses:` or a workflow file
//   image       container image references
//   topic       a GitHub topic on the user's own repo
//   readme      a prose mention in a README or description
//   implied     another tool's evidence implies this one (Argo CD -> GitOps)
//   fork        topic/name/description of a recently pushed fork
//   starred     topic/name/description of a starred repo
//   contribution topic/name/description of someone else's repo the user
//               recently pushed to or opened a PR/issue in
const STRONG_KINDS = new Set(['dependency', 'manifest', 'workflow', 'image']);
const KIND_STRENGTH = {
  dependency: STRENGTH.strong,
  manifest: STRENGTH.strong,
  workflow: STRENGTH.strong,
  image: STRENGTH.strong,
  topic: STRENGTH.topic,
  contribution: STRENGTH.topic,
  implied: STRENGTH.implied,
  readme: STRENGTH.mention,
  fork: STRENGTH.mention,
  starred: STRENGTH.mention,
};
// A line or table row naming this many catalog tools is a list, not usage.
const LIST_TOOLS = 4;

const K8S = ['kubernetes'];

const CATALOG = [
  {
    name: 'kubernetes',
    label: 'Kubernetes',
    aliases: ['kubernetes', 'k8s', 'kube', 'kubectl'],
    mentions: ['kubernetes', 'k8s', 'kubectl'],
    deps: [
      'go:k8s.io/api', 'go:k8s.io/apimachinery', 'npm:@kubernetes/client-node', 'npm:cdk8s', 'npm:cdk8s-plus*',
      'pypi:kubernetes', 'pypi:kubernetes-asyncio', 'cargo:kube', 'cargo:k8s-openapi',
      'action:azure/k8s-*', 'action:azure/setup-kubectl', 'action:helm/kind-action',
    ],
    files: [/(^|\/)(k8s|kubernetes|kube|manifests)\/[^/]+\.ya?ml$/i],
    groups: ['', 'apps', 'batch', 'autoscaling', 'policy', 'k8s.io'],
  },
  {
    name: 'helm',
    label: 'Helm',
    aliases: ['helm', 'helm charts', 'helm chart', 'helmfile'],
    deps: ['go:helm.sh/helm*', 'action:azure/setup-helm', 'action:helm/*'],
    files: [/(^|\/)Chart\.ya?ml$/, /(^|\/)helmfile\.ya?ml$/],
    groups: ['helm.toolkit.fluxcd.io'],
    implies: K8S,
  },
  {
    name: 'kustomize',
    label: 'Kustomize',
    aliases: ['kustomize', 'kustomization'],
    deps: ['go:sigs.k8s.io/kustomize*'],
    files: [/(^|\/)kustomization\.ya?ml$/i],
    groups: ['kustomize.config.k8s.io'],
    implies: K8S,
  },
  {
    name: 'argo-cd',
    label: 'Argo CD',
    aliases: ['argo cd', 'argocd', 'argo'],
    mentions: ['argo cd', 'argocd'],
    deps: ['go:github.com/argoproj/argo-cd*', 'helm:argo-cd'],
    groups: ['argoproj.io/Application', 'argoproj.io/ApplicationSet', 'argoproj.io/AppProject'],
    images: ['argoproj/argocd'],
    implies: ['kubernetes', 'gitops'],
  },
  {
    name: 'argo-rollouts',
    label: 'Argo Rollouts',
    aliases: ['argo rollouts', 'rollouts', 'progressive delivery', 'canary deployments', 'canary'],
    mentions: ['argo rollouts', 'progressive delivery'],
    deps: ['go:github.com/argoproj/argo-rollouts*', 'helm:argo-rollouts'],
    groups: [
      'argoproj.io/Rollout', 'argoproj.io/AnalysisTemplate', 'argoproj.io/ClusterAnalysisTemplate',
      'argoproj.io/AnalysisRun', 'argoproj.io/Experiment',
    ],
    implies: K8S,
  },
  {
    name: 'argo-workflows',
    label: 'Argo Workflows',
    aliases: ['argo workflows', 'argo workflow'],
    deps: ['go:github.com/argoproj/argo-workflows*', 'pypi:hera*', 'helm:argo-workflows'],
    groups: ['argoproj.io/Workflow', 'argoproj.io/WorkflowTemplate', 'argoproj.io/ClusterWorkflowTemplate', 'argoproj.io/CronWorkflow'],
    implies: K8S,
  },
  {
    name: 'argo-events',
    label: 'Argo Events',
    aliases: ['argo events'],
    deps: ['go:github.com/argoproj/argo-events*', 'helm:argo-events'],
    groups: ['argoproj.io/EventSource', 'argoproj.io/Sensor', 'argoproj.io/EventBus'],
    implies: K8S,
  },
  {
    name: 'flux',
    label: 'Flux',
    aliases: ['flux', 'fluxcd', 'flux cd', 'flux2'],
    mentions: ['fluxcd', 'flux cd', 'flux2', 'flux v2'],
    deps: ['go:github.com/fluxcd/*', 'action:fluxcd/*'],
    groups: ['toolkit.fluxcd.io'],
    implies: ['kubernetes', 'gitops'],
  },
  {
    name: 'gitops',
    label: 'GitOps',
    aliases: ['gitops', 'git ops'],
  },
  {
    name: 'opentelemetry',
    label: 'OpenTelemetry',
    aliases: ['opentelemetry', 'otel', 'open telemetry', 'otlp'],
    deps: [
      'npm:@opentelemetry/*', 'go:go.opentelemetry.io/*', 'pypi:opentelemetry-*', 'cargo:opentelemetry*',
      'cargo:tracing-opentelemetry', 'helm:opentelemetry-*',
    ],
    files: [/(^|\/)otel[-_]?collector[^/]*\.ya?ml$/i, /(^|\/)otel[^/]*config[^/]*\.ya?ml$/i],
    groups: ['opentelemetry.io'],
    images: ['opentelemetry-collector*', 'otel/*'],
  },
  {
    name: 'prometheus',
    label: 'Prometheus',
    aliases: ['prometheus', 'promql'],
    deps: [
      'go:github.com/prometheus/*', 'npm:prom-client', 'pypi:prometheus-client', 'pypi:prometheus_client',
      'cargo:prometheus*', 'helm:prometheus', 'helm:kube-prometheus-stack',
    ],
    files: [/(^|\/)prometheus\.ya?ml$/i],
    groups: ['monitoring.coreos.com'],
    images: ['prom/prometheus', 'prometheus/prometheus'],
  },
  {
    name: 'prometheus-operator',
    label: 'Prometheus Operator',
    aliases: ['prometheus operator', 'kube-prometheus', 'kube prometheus stack', 'servicemonitor'],
    deps: ['go:github.com/prometheus-operator/*', 'helm:kube-prometheus-stack'],
    groups: ['monitoring.coreos.com'],
    implies: ['kubernetes', 'prometheus'],
  },
  {
    name: 'grafana',
    label: 'Grafana',
    aliases: ['grafana'],
    deps: ['go:github.com/grafana/grafana*', 'npm:@grafana/*', 'helm:grafana'],
    files: [/(^|\/)grafana\/.+\.json$/i],
    groups: ['grafana.integreatly.org'],
    images: ['grafana/grafana*'],
  },
  {
    name: 'loki',
    label: 'Loki',
    aliases: ['loki', 'grafana loki'],
    mentions: ['grafana loki', 'loki'],
    deps: ['go:github.com/grafana/loki*', 'helm:loki*'],
    images: ['grafana/loki', 'grafana/promtail'],
  },
  {
    name: 'thanos',
    label: 'Thanos',
    aliases: ['thanos'],
    deps: ['go:github.com/thanos-io/*', 'helm:thanos'],
    images: ['thanos/thanos', 'thanos-io/thanos'],
    implies: ['prometheus'],
  },
  {
    name: 'jaeger',
    label: 'Jaeger',
    aliases: ['jaeger', 'jaeger tracing'],
    deps: ['go:github.com/jaegertracing/*', 'npm:jaeger-client', 'pypi:jaeger-client', 'helm:jaeger'],
    groups: ['jaegertracing.io'],
    images: ['jaegertracing/*'],
  },
  {
    name: 'fluent-bit',
    label: 'Fluent Bit',
    aliases: ['fluent bit', 'fluentbit', 'fluent-bit'],
    deps: ['helm:fluent-bit'],
    files: [/(^|\/)fluent-?bit[^/]*\.(conf|ya?ml)$/i],
    groups: ['fluentbit.fluent.io'],
    images: ['fluent/fluent-bit'],
  },
  {
    name: 'fluentd',
    label: 'Fluentd',
    aliases: ['fluentd'],
    deps: ['go:github.com/fluent/fluent-logger-golang', 'npm:fluent-logger', 'pypi:fluent-logger', 'helm:fluentd'],
    files: [/(^|\/)fluentd?\.conf$/i],
    images: ['fluent/fluentd*'],
  },
  {
    name: 'envoy',
    label: 'Envoy',
    aliases: ['envoy', 'envoy proxy', 'envoy gateway'],
    deps: ['go:github.com/envoyproxy/*', 'helm:gateway-helm'],
    files: [/(^|\/)envoy[^/]*\.ya?ml$/i],
    groups: ['gateway.envoyproxy.io'],
    images: ['envoyproxy/*'],
  },
  {
    name: 'istio',
    label: 'Istio',
    aliases: ['istio'],
    deps: ['go:istio.io/*', 'helm:istiod', 'helm:istio-*'],
    groups: ['istio.io'],
    images: ['istio/*'],
    implies: ['kubernetes', 'service-mesh'],
  },
  {
    name: 'linkerd',
    label: 'Linkerd',
    aliases: ['linkerd'],
    deps: ['go:github.com/linkerd/*', 'helm:linkerd*'],
    groups: ['linkerd.io'],
    implies: ['kubernetes', 'service-mesh'],
  },
  {
    name: 'service-mesh',
    label: 'Service mesh',
    aliases: ['service mesh', 'servicemesh'],
  },
  {
    name: 'cilium',
    label: 'Cilium',
    aliases: ['cilium', 'hubble', 'tetragon'],
    deps: ['go:github.com/cilium/cilium*', 'go:github.com/cilium/tetragon*', 'helm:cilium', 'helm:tetragon'],
    groups: ['cilium.io'],
    images: ['cilium/*'],
    implies: ['kubernetes', 'ebpf'],
  },
  {
    name: 'ebpf',
    label: 'eBPF',
    aliases: ['ebpf', 'bpf', 'libbpf'],
    mentions: ['ebpf', 'libbpf'],
    deps: ['go:github.com/cilium/ebpf', 'go:github.com/aquasecurity/libbpfgo', 'cargo:aya*', 'cargo:libbpf-rs', 'pypi:bcc'],
    files: [/\.bpf\.c$/i, /(^|\/)bpf\/[^/]+\.[ch]$/i],
  },
  {
    name: 'containerd',
    label: 'containerd',
    aliases: ['containerd', 'cri-o', 'runc', 'container runtime'],
    deps: ['go:github.com/containerd/*', 'go:github.com/opencontainers/runc', 'go:github.com/cri-o/*'],
  },
  {
    name: 'docker',
    common: true,
    label: 'Docker',
    aliases: ['docker', 'containers', 'container', 'dockerfile', 'podman', 'docker compose'],
    mentions: ['docker', 'dockerfile', 'podman', 'docker compose'],
    deps: ['go:github.com/docker/*', 'npm:dockerode', 'pypi:docker', 'action:docker/*'],
    files: [/(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$/, /\.dockerfile$/i, /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i],
  },
  {
    name: 'buildpacks',
    label: 'Buildpacks',
    aliases: ['buildpacks', 'buildpack', 'cloud native buildpacks', 'paketo'],
    deps: ['action:buildpacks/*'],
    files: [/(^|\/)project\.toml$/],
    images: ['paketobuildpacks/*', 'buildpacksio/*'],
  },
  {
    name: 'harbor',
    label: 'Harbor',
    aliases: ['harbor', 'container registry'],
    mentions: ['harbor registry', 'goharbor'],
    deps: ['go:github.com/goharbor/*', 'helm:harbor'],
    images: ['goharbor/*'],
  },
  {
    name: 'crossplane',
    label: 'Crossplane',
    aliases: ['crossplane'],
    deps: ['go:github.com/crossplane/*', 'helm:crossplane'],
    groups: ['crossplane.io', 'upbound.io'],
    implies: ['kubernetes', 'platform-engineering'],
  },
  {
    name: 'terraform',
    label: 'Terraform',
    aliases: ['terraform', 'hcl', 'infrastructure as code', 'iac'],
    mentions: ['terraform', 'infrastructure as code'],
    deps: ['go:github.com/hashicorp/terraform*', 'action:hashicorp/setup-terraform', 'npm:cdktf', 'pypi:cdktf'],
    files: [/\.tf$/, /(^|\/)\.terraform\.lock\.hcl$/],
  },
  {
    name: 'opentofu',
    label: 'OpenTofu',
    aliases: ['opentofu', 'tofu'],
    mentions: ['opentofu'],
    deps: ['go:github.com/opentofu/*', 'action:opentofu/*'],
    files: [/\.tofu$/],
  },
  {
    name: 'pulumi',
    label: 'Pulumi',
    aliases: ['pulumi'],
    deps: ['npm:@pulumi/*', 'pypi:pulumi*', 'go:github.com/pulumi/*', 'action:pulumi/*'],
    files: [/(^|\/)Pulumi(\.[\w-]+)?\.ya?ml$/],
  },
  {
    name: 'ansible',
    label: 'Ansible',
    aliases: ['ansible'],
    deps: ['pypi:ansible*'],
    files: [/(^|\/)ansible\.cfg$/, /(^|\/)roles\/[^/]+\/tasks\/main\.ya?ml$/, /(^|\/)playbook[^/]*\.ya?ml$/i],
  },
  {
    name: 'backstage',
    label: 'Backstage',
    aliases: ['backstage', 'developer portal', 'internal developer portal'],
    deps: ['npm:@backstage/*'],
    files: [/(^|\/)catalog-info\.ya?ml$/],
    groups: ['backstage.io'],
    implies: ['platform-engineering'],
  },
  {
    name: 'platform-engineering',
    label: 'Platform engineering',
    aliases: ['platform engineering', 'internal developer platform', 'developer platform', 'platform team'],
  },
  {
    name: 'keda',
    label: 'KEDA',
    aliases: ['keda', 'event driven autoscaling', 'autoscaling'],
    mentions: ['keda', 'event-driven autoscaling', 'event driven autoscaling'],
    deps: ['go:github.com/kedacore/*', 'helm:keda'],
    groups: ['keda.sh'],
    implies: K8S,
  },
  {
    name: 'knative',
    label: 'Knative',
    aliases: ['knative', 'serverless'],
    mentions: ['knative'],
    deps: ['go:knative.dev/*'],
    groups: ['knative.dev'],
    implies: K8S,
  },
  {
    name: 'dapr',
    label: 'Dapr',
    aliases: ['dapr'],
    deps: ['go:github.com/dapr/*', 'npm:@dapr/*', 'npm:dapr-client', 'pypi:dapr*', 'cargo:dapr*', 'helm:dapr'],
    groups: ['dapr.io'],
  },
  {
    name: 'cert-manager',
    label: 'cert-manager',
    aliases: ['cert-manager', 'cert manager', 'certmanager', 'tls certificates', 'lets encrypt', 'letsencrypt'],
    mentions: ['cert-manager', 'cert manager', 'letsencrypt', "let's encrypt"],
    deps: ['go:github.com/cert-manager/*', 'go:github.com/jetstack/cert-manager*', 'helm:cert-manager'],
    groups: ['cert-manager.io'],
    implies: K8S,
  },
  {
    name: 'external-secrets',
    label: 'External Secrets',
    aliases: ['external secrets', 'external-secrets', 'eso', 'secrets management'],
    mentions: ['external secrets', 'external-secrets', 'secrets management'],
    deps: ['go:github.com/external-secrets/*', 'helm:external-secrets'],
    groups: ['external-secrets.io'],
    implies: K8S,
  },
  {
    name: 'vault',
    label: 'Vault',
    aliases: ['vault', 'hashicorp vault', 'openbao'],
    mentions: ['hashicorp vault', 'openbao', 'vault agent'],
    deps: ['go:github.com/hashicorp/vault*', 'go:github.com/openbao/*', 'npm:node-vault', 'pypi:hvac', 'helm:vault', 'helm:openbao'],
    groups: ['secrets.hashicorp.com'],
    images: ['hashicorp/vault', 'openbao/openbao'],
  },
  {
    name: 'opa',
    label: 'OPA',
    aliases: ['opa', 'open policy agent', 'rego', 'policy as code'],
    mentions: ['open policy agent', 'rego', 'policy as code'],
    deps: ['go:github.com/open-policy-agent/opa*', 'action:open-policy-agent/*'],
    files: [/\.rego$/],
    images: ['openpolicyagent/opa'],
  },
  {
    name: 'gatekeeper',
    label: 'Gatekeeper',
    aliases: ['gatekeeper', 'opa gatekeeper'],
    mentions: ['opa gatekeeper', 'gatekeeper.sh'],
    deps: ['go:github.com/open-policy-agent/gatekeeper*', 'go:github.com/open-policy-agent/frameworks*', 'helm:gatekeeper'],
    groups: ['gatekeeper.sh'],
    implies: ['kubernetes', 'opa'],
  },
  {
    name: 'kyverno',
    label: 'Kyverno',
    aliases: ['kyverno'],
    deps: ['go:github.com/kyverno/*', 'helm:kyverno*', 'action:kyverno/*'],
    groups: ['kyverno.io'],
    implies: K8S,
  },
  {
    name: 'falco',
    label: 'Falco',
    aliases: ['falco', 'runtime security'],
    mentions: ['falco'],
    deps: ['go:github.com/falcosecurity/*', 'helm:falco*'],
    files: [/falco[^/]*rules[^/]*\.ya?ml$/i],
    images: ['falcosecurity/*'],
  },
  {
    name: 'trivy',
    label: 'Trivy',
    aliases: ['trivy', 'vulnerability scanning', 'image scanning'],
    mentions: ['trivy'],
    deps: ['go:github.com/aquasecurity/trivy*', 'action:aquasecurity/trivy-action', 'action:aquasecurity/setup-trivy'],
    groups: ['aquasecurity.github.io'],
  },
  {
    name: 'sigstore',
    label: 'Sigstore',
    aliases: ['sigstore', 'cosign', 'supply chain security', 'software supply chain', 'slsa', 'sbom'],
    mentions: ['sigstore', 'cosign', 'slsa', 'sbom', 'supply chain security'],
    deps: ['go:github.com/sigstore/*', 'npm:sigstore', 'npm:@sigstore/*', 'pypi:sigstore', 'action:sigstore/*', 'action:slsa-framework/*', 'action:anchore/sbom-action'],
    groups: ['policy.sigstore.dev'],
  },
  {
    name: 'spiffe',
    label: 'SPIFFE',
    aliases: ['spiffe', 'spire', 'workload identity'],
    mentions: ['spiffe', 'spire server', 'spire agent', 'workload identity'],
    deps: ['go:github.com/spiffe/*', 'helm:spire*'],
    groups: ['spiffe.io'],
    images: ['spiffe/*'],
  },
  {
    name: 'etcd',
    label: 'etcd',
    aliases: ['etcd'],
    deps: ['go:go.etcd.io/*', 'npm:etcd3', 'pypi:etcd3', 'cargo:etcd-client', 'helm:etcd'],
    images: ['coreos/etcd', 'etcd', 'etcd-io/etcd'],
  },
  {
    name: 'coredns',
    label: 'CoreDNS',
    aliases: ['coredns', 'kubernetes dns'],
    mentions: ['coredns'],
    deps: ['go:github.com/coredns/*'],
    files: [/(^|\/)Corefile$/],
    images: ['coredns/coredns'],
  },
  {
    name: 'gateway-api',
    label: 'Gateway API',
    aliases: ['gateway api', 'gateway-api', 'httproute', 'ingress'],
    mentions: ['gateway api', 'httproute'],
    deps: ['go:sigs.k8s.io/gateway-api*'],
    groups: ['gateway.networking.k8s.io'],
    implies: K8S,
  },
  {
    name: 'nats',
    label: 'NATS',
    aliases: ['nats', 'jetstream'],
    deps: ['go:github.com/nats-io/*', 'npm:nats', 'npm:nats.ws', 'npm:@nats-io/*', 'pypi:nats-py', 'cargo:async-nats', 'cargo:nats', 'helm:nats'],
    groups: ['nats.io'],
    images: ['nats', 'nats-io/*'],
  },
  {
    name: 'kafka',
    label: 'Kafka',
    aliases: ['kafka', 'apache kafka', 'strimzi', 'event streaming'],
    mentions: ['kafka', 'strimzi'],
    deps: [
      'go:github.com/segmentio/kafka-go', 'go:github.com/confluentinc/confluent-kafka-go*', 'go:github.com/ibm/sarama',
      'go:github.com/shopify/sarama', 'go:github.com/twmb/franz-go*', 'npm:kafkajs', 'npm:node-rdkafka',
      'npm:@confluentinc/*', 'pypi:kafka-python', 'pypi:confluent-kafka', 'pypi:aiokafka', 'cargo:rdkafka',
      'helm:kafka', 'helm:strimzi*',
    ],
    groups: ['kafka.strimzi.io'],
    images: ['bitnami/kafka', 'confluentinc/cp-kafka', 'apache/kafka', 'strimzi/*'],
  },
  {
    name: 'postgres',
    label: 'PostgreSQL',
    aliases: ['postgres', 'postgresql', 'psql'],
    mentions: ['postgres', 'postgresql'],
    deps: [
      'npm:pg', 'npm:postgres', 'npm:@neondatabase/serverless', 'go:github.com/jackc/pgx*', 'go:github.com/lib/pq',
      'pypi:psycopg*', 'pypi:asyncpg', 'pypi:pg8000', 'cargo:tokio-postgres', 'cargo:postgres', 'cargo:sqlx',
      'helm:postgresql*',
    ],
    images: ['postgres', 'bitnami/postgresql', 'cloudnative-pg/postgresql', 'postgis/postgis'],
  },
  {
    name: 'cloudnativepg',
    label: 'CloudNativePG',
    aliases: ['cloudnativepg', 'cnpg', 'cloudnative-pg'],
    deps: ['go:github.com/cloudnative-pg/*', 'helm:cloudnative-pg'],
    groups: ['postgresql.cnpg.io'],
    implies: ['kubernetes', 'postgres'],
  },
  {
    name: 'wasm',
    label: 'WebAssembly',
    aliases: ['wasm', 'webassembly', 'wasi', 'spin', 'wasmcloud'],
    mentions: ['wasm', 'webassembly', 'wasi', 'wasmcloud'],
    deps: [
      'cargo:wasm-bindgen*', 'cargo:wasmtime*', 'cargo:wasmer*', 'cargo:spin-sdk', 'cargo:wit-bindgen*',
      'go:github.com/tetratelabs/wazero', 'go:github.com/bytecodealliance/*', 'npm:@bytecodealliance/*',
      'npm:assemblyscript', 'pypi:wasmtime',
    ],
    files: [/\.wat$/, /\.wasm$/, /(^|\/)spin\.toml$/, /\.wit$/],
  },
  {
    name: 'kubeflow',
    label: 'Kubeflow',
    aliases: ['kubeflow', 'kubeflow pipelines', 'mlops'],
    mentions: ['kubeflow', 'mlops'],
    deps: ['pypi:kfp*', 'pypi:kubeflow*', 'go:github.com/kubeflow/*'],
    groups: ['kubeflow.org'],
    implies: K8S,
  },
  {
    name: 'kserve',
    label: 'KServe',
    aliases: ['kserve', 'model serving', 'inference'],
    mentions: ['kserve', 'model serving'],
    deps: ['pypi:kserve', 'go:github.com/kserve/*'],
    groups: ['serving.kserve.io'],
    implies: K8S,
  },
  {
    name: 'ray',
    label: 'Ray',
    aliases: ['ray', 'kuberay', 'ray serve'],
    mentions: ['kuberay', 'ray serve', 'ray cluster', 'ray.io', 'anyscale'],
    deps: ['pypi:ray', 'go:github.com/ray-project/*', 'helm:kuberay*', 'helm:ray-cluster'],
    groups: ['ray.io'],
  },
  {
    name: 'vllm',
    label: 'vLLM',
    aliases: ['vllm', 'llm inference', 'llm serving'],
    mentions: ['vllm', 'llm-d'],
    deps: ['pypi:vllm*'],
    images: ['vllm/*'],
    implies: ['llm'],
  },
  {
    name: 'llm',
    label: 'AI',
    aliases: ['llm', 'llms', 'ai', 'genai', 'gen ai', 'generative ai', 'large language models', 'ai agents', 'agents', 'mcp', 'machine learning', 'ml'],
    mentions: ['llm', 'llms', 'large language model', 'genai', 'generative ai', 'openai', 'anthropic', 'langchain', 'ollama', 'model context protocol', 'ai agent', 'ai agents'],
    deps: [
      'npm:openai', 'npm:@anthropic-ai/*', 'npm:langchain', 'npm:@langchain/*', 'npm:ai', 'npm:@ai-sdk/*', 'npm:ollama',
      'npm:@modelcontextprotocol/*', 'pypi:openai', 'pypi:anthropic', 'pypi:langchain*', 'pypi:transformers',
      'pypi:llama-index*', 'pypi:llama_index*', 'pypi:litellm', 'pypi:ollama', 'pypi:mcp',
      'go:github.com/sashabaranov/go-openai', 'go:github.com/openai/openai-go*', 'go:github.com/anthropics/*',
      'go:github.com/tmc/langchaingo', 'go:github.com/mark3labs/mcp-go', 'go:github.com/modelcontextprotocol/*',
    ],
    images: ['ollama/ollama'],
  },
  {
    name: 'karpenter',
    label: 'Karpenter',
    aliases: ['karpenter', 'node autoscaling', 'cluster autoscaler'],
    mentions: ['karpenter', 'cluster autoscaler'],
    deps: ['go:sigs.k8s.io/karpenter*', 'go:github.com/aws/karpenter*', 'helm:karpenter*'],
    groups: ['karpenter.sh', 'karpenter.k8s.aws'],
    implies: K8S,
  },
  {
    name: 'cluster-api',
    label: 'Cluster API',
    aliases: ['cluster api', 'cluster-api', 'capi'],
    mentions: ['cluster api', 'cluster-api'],
    deps: ['go:sigs.k8s.io/cluster-api*'],
    groups: ['cluster.x-k8s.io'],
    implies: K8S,
  },
  {
    name: 'kubevirt',
    label: 'KubeVirt',
    aliases: ['kubevirt', 'virtual machines on kubernetes'],
    deps: ['go:kubevirt.io/*'],
    groups: ['kubevirt.io'],
    implies: K8S,
  },
  {
    name: 'operators',
    label: 'Operators',
    aliases: ['operators', 'operator', 'kubernetes operators', 'operator sdk', 'operator-sdk', 'kubebuilder', 'controller-runtime', 'controllers', 'crds', 'crd', 'custom resources'],
    mentions: ['kubernetes operator', 'operator sdk', 'operator-sdk', 'kubebuilder', 'controller-runtime', 'custom resource definition', 'reconcile loop', 'reconciler'],
    deps: [
      'go:sigs.k8s.io/controller-runtime', 'go:sigs.k8s.io/kubebuilder*', 'go:github.com/operator-framework/*',
      'pypi:kopf', 'cargo:kube-runtime', 'npm:@dot-i/k8s-operator',
    ],
    files: [/^PROJECT$/],
    groups: ['apiextensions.k8s.io/CustomResourceDefinition', 'operators.coreos.com'],
    implies: K8S,
  },
  {
    name: 'client-go',
    label: 'client-go',
    aliases: ['client-go', 'client go', 'kubernetes api', 'kubernetes client'],
    mentions: ['client-go'],
    deps: ['go:k8s.io/client-go'],
    implies: K8S,
  },
  {
    name: 'grpc',
    label: 'gRPC',
    aliases: ['grpc', 'protobuf', 'protocol buffers'],
    deps: [
      'go:google.golang.org/grpc', 'go:google.golang.org/protobuf', 'go:connectrpc.com/*', 'npm:@grpc/*', 'npm:grpc',
      'npm:@connectrpc/*', 'pypi:grpcio*', 'cargo:tonic*', 'cargo:prost*',
    ],
    files: [/\.proto$/, /(^|\/)buf(\.gen)?\.ya?ml$/],
  },
  {
    name: 'tekton',
    label: 'Tekton',
    aliases: ['tekton', 'tekton pipelines'],
    deps: ['go:github.com/tektoncd/*'],
    files: [/^\.tekton\//],
    groups: ['tekton.dev'],
    implies: ['kubernetes', 'ci-cd'],
  },
  {
    name: 'github-actions',
    common: true,
    label: 'GitHub Actions',
    aliases: ['github actions', 'gh actions', 'actions'],
    mentions: ['github actions'],
    deps: ['npm:@actions/*'],
    files: [/^\.github\/workflows\/[^/]+\.ya?ml$/],
    implies: ['ci-cd'],
  },
  {
    name: 'ci-cd',
    common: true,
    label: 'CI/CD',
    aliases: ['ci/cd', 'cicd', 'ci-cd', 'ci', 'cd', 'continuous integration', 'continuous delivery', 'continuous deployment', 'jenkins', 'gitlab ci'],
    mentions: ['ci/cd', 'continuous integration', 'continuous delivery', 'continuous deployment', 'jenkins', 'gitlab ci'],
    files: [/^\.gitlab-ci\.ya?ml$/, /(^|\/)Jenkinsfile$/, /^\.circleci\//, /(^|\/)\.drone\.ya?ml$/, /(^|\/)azure-pipelines\.ya?ml$/, /^\.buildkite\//],
  },
  {
    name: 'openfeature',
    label: 'OpenFeature',
    aliases: ['openfeature', 'feature flags', 'feature flagging'],
    mentions: ['openfeature', 'feature flags'],
    deps: ['npm:@openfeature/*', 'go:github.com/open-feature/*', 'pypi:openfeature*'],
    groups: ['openfeature.dev'],
  },
  {
    name: 'chaos-engineering',
    label: 'Chaos engineering',
    aliases: ['chaos engineering', 'chaos mesh', 'litmus', 'litmuschaos', 'chaos'],
    mentions: ['chaos engineering', 'chaos mesh', 'litmuschaos'],
    deps: ['go:github.com/chaos-mesh/*', 'go:github.com/litmuschaos/*', 'helm:chaos-mesh', 'helm:litmus*'],
    groups: ['chaos-mesh.org', 'litmuschaos.io'],
  },
  {
    name: 'observability',
    label: 'Observability',
    aliases: ['observability', 'o11y', 'monitoring', 'tracing', 'distributed tracing', 'logging', 'metrics'],
    mentions: ['observability', 'distributed tracing'],
  },
  {
    name: 'security',
    label: 'Security',
    aliases: ['security', 'cloud native security', 'devsecops', 'zero trust'],
    mentions: ['devsecops', 'zero trust'],
  },
];

// ---------------------------------------------------------------- helpers

function compact(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9+#]/g, '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A phrase as a word-bounded regex that tolerates `-`, `_`, `.` or spaces
// between its words ("argo cd" matches "argo-cd" and "Argo CD").
function phraseRegex(phrase) {
  const words = phrase.toLowerCase().split(/[\s\-_]+/).filter(Boolean).map(escapeRe);
  return new RegExp(`(?:^|[^a-z0-9])${words.join('[\\s\\-_.]*')}(?![a-z0-9])`);
}

function globMatch(pattern, value) {
  return pattern.endsWith('*') ? value.startsWith(pattern.slice(0, -1)) : value === pattern;
}

const BY_NAME = new Map(CATALOG.map((t) => [t.name, t]));
// compact alias -> tool name (first catalog entry wins)
const ALIAS = new Map();
for (const t of CATALOG) {
  for (const a of [t.name, t.label, ...(t.aliases || [])]) {
    const k = compact(a);
    if (k && !ALIAS.has(k)) ALIAS.set(k, t.name);
  }
}
const MENTION_RES = CATALOG.map((t) => ({
  name: t.name,
  res: (t.mentions || t.aliases || [t.name]).filter((m) => compact(m).length >= 3).map(phraseRegex),
}));
// Longest aliases first, so "argo rollouts" wins over "argo" inside a phrase.
const ALIAS_RES = CATALOG.flatMap((t) =>
  [t.name, t.label, ...(t.aliases || [])].map((a) => ({ name: t.name, len: a.length, re: phraseRegex(a) })),
).sort((a, b) => b.len - a.len);

// Profile-level score multiplier: damp tools nearly every repo has.
function damping(name) {
  return BY_NAME.get(name)?.common ? 0.5 : 1;
}

function label(name) {
  return BY_NAME.get(name)?.label || name;
}

function lookupAlias(text) {
  return ALIAS.get(compact(text)) || null;
}

// ------------------------------------------------------- signal matching

function manifestMatches(spec, { group, kind }) {
  const [g, k] = spec.includes('/') ? spec.split('/') : [spec, null];
  if (k && k !== kind) return false;
  if (g === '') return group === '';
  return group === g || group.endsWith(`.${g}`);
}

function imageMatches(pattern, image) {
  const last = image.split('/').pop();
  if (pattern.includes('/') && !pattern.endsWith('*')) return image === pattern || image.endsWith(`/${pattern}`);
  if (pattern.includes('/')) return globMatch(pattern, image) || image.includes(`/${pattern.slice(0, -1)}`);
  return globMatch(pattern, last) || globMatch(pattern, image);
}

function mentionedIn(line) {
  const hits = [];
  for (const { name, res } of MENTION_RES) if (res.some((re) => re.test(line))) hits.push(name);
  return hits;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)]|\|)/;

// Prose mentions, counted per line. A line or table row naming LIST_TOOLS or
// more catalog tools is a list ("works with Argo CD, Flux, Cilium, Kyverno…"),
// and so is a run of short list items that together name that many: neither
// says the author uses any of them. Returns Map(tool -> mention lines).
function countMentions(text) {
  const out = new Map();
  const lines = String(text || '').toLowerCase().split(/\r?\n/);
  const hitsByLine = lines.map((l) => (l.trim() ? mentionedIn(l) : []));
  const skip = hitsByLine.map((hits) => hits.length >= LIST_TOOLS);
  for (let i = 0; i < lines.length; i++) {
    if (!LIST_ITEM.test(lines[i])) continue;
    // A run of list items: short items naming tools, LIST_TOOLS+ distinct in all.
    let j = i;
    const names = new Set();
    let allShort = true;
    while (j < lines.length && LIST_ITEM.test(lines[j])) {
      hitsByLine[j].forEach((n) => names.add(n));
      if (hitsByLine[j].length && lines[j].split(/\s+/).filter((w) => /[a-z]/.test(w)).length > 8) allShort = false;
      j++;
    }
    if (names.size >= LIST_TOOLS && allShort) for (let k = i; k < j; k++) skip[k] = true;
    i = j - 1;
  }
  hitsByLine.forEach((hits, i) => {
    if (skip[i]) return;
    for (const n of hits) out.set(n, (out.get(n) || 0) + 1);
  });
  return out;
}

// signals: { deps: ["npm:pg", "action:docker/build-push-action"], paths: [],
//            manifests: [{group, kind}], images: [], topics: [],
//            text: "description + README prose (code blocks stripped)" }
// Returns Map(toolName -> Map(kind -> occurrences)) for one repo. Tools that
// strong or topic evidence implies get an `implied` entry.
function detectEvidence(signals = {}) {
  const found = new Map();
  const add = (name, kind, n = 1) => {
    if (!BY_NAME.has(name) || n <= 0) return;
    const kinds = found.get(name) || new Map();
    kinds.set(kind, (kinds.get(kind) || 0) + n);
    found.set(name, kinds);
  };
  const deps = (signals.deps || []).map((d) => d.toLowerCase());
  const paths = signals.paths || [];
  const manifests = signals.manifests || [];
  const images = (signals.images || []).map((i) => i.toLowerCase());
  const count = (list, pred) => list.reduce((n, x) => n + (pred(x) ? 1 : 0), 0);

  for (const t of CATALOG) {
    const depPats = (t.deps || []).map((p) => p.toLowerCase());
    const depHit = (d) => depPats.some((p) => globMatch(p, d));
    add(t.name, 'dependency', count(deps, (d) => !d.startsWith('action:') && depHit(d)));
    add(t.name, 'workflow', count(deps, (d) => d.startsWith('action:') && depHit(d)));
    const fileHit = (p) => (t.files || []).some((re) => re.test(p));
    add(t.name, 'workflow', count(paths, (p) => p.startsWith('.github/workflows/') && fileHit(p)));
    add(t.name, 'manifest', count(paths, (p) => !p.startsWith('.github/workflows/') && fileHit(p)));
    add(t.name, 'manifest', count(manifests, (m) => (t.groups || []).some((g) => manifestMatches(g, m))));
    add(t.name, 'image', count(images, (i) => (t.images || []).some((p) => imageMatches(p, i))));
  }
  for (const topic of signals.topics || []) {
    const name = lookupAlias(topic);
    if (name) add(name, 'topic');
  }
  for (const [name, n] of countMentions(signals.text)) add(name, 'readme', n);
  for (const [name, kinds] of [...found]) {
    if (![...kinds.keys()].some((k) => STRONG_KINDS.has(k) || k === 'topic')) continue;
    for (const other of BY_NAME.get(name).implies || []) {
      if (!found.get(other)?.has('implied')) add(other, 'implied');
    }
  }
  return found;
}

// Weak signals from a repo the user doesn't own or didn't write: its topics,
// name and description, all counted as `kind` (fork | starred | contribution).
function detectInterest(repo, kind) {
  const found = new Map();
  const names = new Set();
  for (const topic of repo.topics || []) {
    const n = lookupAlias(topic);
    if (n) names.add(n);
  }
  const text = `${String(repo.name || '').replace(/[-_.]+/g, ' ')}\n${repo.description || ''}`.toLowerCase();
  for (const n of mentionedIn(text)) names.add(n);
  for (const n of names) found.set(n, new Map([[kind, 1]]));
  return found;
}

// Map(toolName -> strength) for one repo: the strongest kind of evidence.
function detectTools(signals = {}) {
  const out = new Map();
  for (const [name, kinds] of detectEvidence(signals)) {
    out.set(name, Math.max(...[...kinds.keys()].map((k) => KIND_STRENGTH[k] || 0)));
  }
  return out;
}

// Free text -> catalog tools it names, plus the phrases that named none.
function matchInterests(text) {
  const phrases = String(text)
    .split(/[,;\n\r|]+|\s+(?:and|&)\s+/i)
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
  const tools = [];
  const rest = [];
  const add = (n) => {
    if (!tools.includes(n)) tools.push(n);
  };
  for (const phrase of phrases) {
    const whole = lookupAlias(phrase);
    if (whole) {
      add(whole);
      continue;
    }
    let remaining = ` ${phrase.toLowerCase()} `;
    const hits = [];
    for (const { name, re } of ALIAS_RES) {
      if (re.test(remaining)) {
        hits.push(name);
        remaining = remaining.replace(re, ' ');
      }
    }
    hits.forEach(add);
    if (!hits.length) rest.push(phrase.toLowerCase());
  }
  return { tools, rest };
}

module.exports = {
  CATALOG, STRENGTH, STRONG_KINDS, KIND_STRENGTH, detectTools, detectEvidence, detectInterest, countMentions,
  matchInterests, lookupAlias, label, damping, phraseRegex, compact,
};
