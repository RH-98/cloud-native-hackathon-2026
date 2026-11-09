// Display labels and search terms for the tools and topics people match on.
// Shared by the matcher (labels in "why" lines) and the fake-attendee
// generator (picking sessions that match an attendee's interests).

// Canonical key for a term: lowercase, letters and digits only, with a few
// common aliases folded in. "Argo CD", "argo-cd" and "argocd" all become "argocd".
const ALIASES = {
  otel: 'opentelemetry',
  k8s: 'kubernetes',
  cnpg: 'cloudnativepg',
  postgresql: 'postgres',
  opa: 'openpolicyagent',
  argo: 'argocd',
  fluxcd: 'flux',
  spire: 'spiffe',
  kubeflowpipelines: 'kubeflow',
  golang: 'go',
};

function termKey(term) {
  const key = String(term || '').toLowerCase().replace(/[^a-z0-9+#]/g, '');
  return ALIASES[key] || key;
}

// key -> { label, terms }: terms are lowercase phrases searched for in session text.
const TOOLS = {
  argocd: { label: 'Argo CD', terms: ['argo cd', 'argocd'] },
  backstage: { label: 'Backstage', terms: ['backstage'] },
  crossplane: { label: 'Crossplane', terms: ['crossplane'] },
  flux: { label: 'Flux', terms: ['flux'] },
  helm: { label: 'Helm', terms: ['helm'] },
  kustomize: { label: 'Kustomize', terms: ['kustomize'] },
  kubernetes: { label: 'Kubernetes', terms: ['kubernetes'] },
  opentofu: { label: 'OpenTofu', terms: ['opentofu', 'terraform'] },
  opentelemetry: { label: 'OpenTelemetry', terms: ['opentelemetry', 'otel'] },
  prometheus: { label: 'Prometheus', terms: ['prometheus'] },
  grafana: { label: 'Grafana', terms: ['grafana'] },
  jaeger: { label: 'Jaeger', terms: ['jaeger'] },
  fluentbit: { label: 'Fluent Bit', terms: ['fluent bit', 'fluentd'] },
  thanos: { label: 'Thanos', terms: ['thanos'] },
  cortex: { label: 'Cortex', terms: ['cortex'] },
  falco: { label: 'Falco', terms: ['falco'] },
  kyverno: { label: 'Kyverno', terms: ['kyverno'] },
  sigstore: { label: 'Sigstore', terms: ['sigstore', 'cosign'] },
  spiffe: { label: 'SPIFFE/SPIRE', terms: ['spiffe', 'spire'] },
  openpolicyagent: { label: 'Open Policy Agent', terms: ['open policy agent', 'opa ', 'gatekeeper'] },
  certmanager: { label: 'cert-manager', terms: ['cert-manager'] },
  intoto: { label: 'in-toto', terms: ['in-toto', 'slsa'] },
  cilium: { label: 'Cilium', terms: ['cilium'] },
  ebpf: { label: 'eBPF', terms: ['ebpf'] },
  envoy: { label: 'Envoy', terms: ['envoy'] },
  istio: { label: 'Istio', terms: ['istio', 'ambient mesh'] },
  linkerd: { label: 'Linkerd', terms: ['linkerd'] },
  gatewayapi: { label: 'Gateway API', terms: ['gateway api'] },
  coredns: { label: 'CoreDNS', terms: ['coredns', 'dns'] },
  kubeflow: { label: 'Kubeflow', terms: ['kubeflow'] },
  ray: { label: 'Ray', terms: ['ray ', 'kuberay'] },
  vllm: { label: 'vLLM', terms: ['vllm'] },
  kserve: { label: 'KServe', terms: ['kserve'] },
  kueue: { label: 'Kueue', terms: ['kueue', 'batch'] },
  llmd: { label: 'llm-d', terms: ['llm-d'] },
  cloudnativepg: { label: 'CloudNativePG', terms: ['cloudnativepg', 'cnpg'] },
  postgres: { label: 'Postgres', terms: ['postgres'] },
  kafka: { label: 'Kafka', terms: ['kafka'] },
  strimzi: { label: 'Strimzi', terms: ['strimzi'] },
  vitess: { label: 'Vitess', terms: ['vitess'] },
  rook: { label: 'Rook', terms: ['rook', 'ceph'] },
  etcd: { label: 'etcd', terms: ['etcd'] },
  keda: { label: 'KEDA', terms: ['keda', 'autoscal'] },
  karpenter: { label: 'Karpenter', terms: ['karpenter'] },
  chaosmesh: { label: 'Chaos Mesh', terms: ['chaos mesh', 'chaos engineering'] },
  litmus: { label: 'LitmusChaos', terms: ['litmus'] },
  docker: { label: 'Docker', terms: ['container image', 'docker'] },
  kubevirt: { label: 'KubeVirt', terms: ['kubevirt'] },
  harbor: { label: 'Harbor', terms: ['harbor'] },
};

const TOPICS = {
  gitops: { label: 'GitOps', terms: ['gitops'] },
  platformengineering: { label: 'platform engineering', terms: ['platform engineering', 'internal developer platform'] },
  developerexperience: { label: 'developer experience', terms: ['developer experience', 'devex'] },
  observability: { label: 'observability', terms: ['observability'] },
  tracing: { label: 'tracing', terms: ['tracing'] },
  monitoring: { label: 'monitoring', terms: ['monitoring', 'metrics'] },
  slo: { label: 'SLOs', terms: ['slo'] },
  supplychainsecurity: { label: 'supply-chain security', terms: ['supply chain', 'sbom'] },
  policyascode: { label: 'policy as code', terms: ['policy'] },
  zerotrust: { label: 'zero trust', terms: ['zero trust', 'identity'] },
  runtimesecurity: { label: 'runtime security', terms: ['runtime security'] },
  servicemesh: { label: 'service mesh', terms: ['service mesh', 'mesh'] },
  networking: { label: 'networking', terms: ['network'] },
  mlops: { label: 'MLOps', terms: ['mlops', 'machine learning'] },
  llminference: { label: 'LLM inference', terms: ['inference', 'llm'] },
  gpu: { label: 'GPUs', terms: ['gpu'] },
  aiagents: { label: 'AI agents', terms: ['agent'] },
  databases: { label: 'databases', terms: ['database'] },
  streaming: { label: 'streaming', terms: ['streaming', 'event-driven'] },
  storage: { label: 'storage', terms: ['storage', 'stateful'] },
  operators: { label: 'operators', terms: ['operator'] },
  reliability: { label: 'reliability', terms: ['reliability', 'sre'] },
  autoscaling: { label: 'autoscaling', terms: ['autoscal', 'scaling'] },
  incidentresponse: { label: 'incident response', terms: ['incident', 'on-call'] },
  chaosengineering: { label: 'chaos engineering', terms: ['chaos'] },
  multicluster: { label: 'multi-cluster', terms: ['multi-cluster', 'multicluster'] },
  costoptimization: { label: 'cost optimization', terms: ['cost', 'finops'] },
  learning: { label: 'learning cloud native', terms: ['beginner', 'getting started', 'introduction'] },
  community: { label: 'open-source community', terms: ['contributor', 'community', 'contribfest'] },
  sustainability: { label: 'sustainability', terms: ['sustainab', 'green'] },
  kubernetes: { label: 'Kubernetes', terms: ['kubernetes'] },
};

// Best display label for a term: the catalog's, else the label the data gave,
// else the term itself with dashes as spaces.
function labelFor(term, fallback) {
  const key = termKey(term);
  const known = TOOLS[key] || TOPICS[key];
  if (known) return known.label;
  if (fallback) return fallback;
  return String(term || '').replace(/[-_]+/g, ' ').trim();
}

module.exports = { ALIASES, TOOLS, TOPICS, termKey, labelFor };
