# Kubernetes Guestbook with Prometheus + Grafana Monitoring

A [Pulumi](https://www.pulumi.com/) TypeScript deployment of the classic [Kubernetes Guestbook](https://kubernetes.io/docs/tutorials/stateless-application/guestbook/) application, extended with a full observability stack (Prometheus + Grafana) and a pre-built Guestbook dashboard.

## Architecture

```
default namespace
├── frontend (3 replicas)  ← PHP guestbook UI
├── redis-leader           ← Redis primary + redis_exporter sidecar
└── redis-replica          ← Redis replica  + redis_exporter sidecar

monitoring namespace
├── prometheus             ← Scrapes redis_exporter metrics + pod metrics
└── grafana                ← Pre-loaded "Guestbook Monitoring" dashboard
```

## Prerequisites

| Tool | Install |
|------|---------|
| [Node.js](https://nodejs.org/) ≥ 18 | `brew install node` / apt |
| [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) | `curl -fsSL https://get.pulumi.com | sh` |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | `brew install kubectl` / apt |
| [kind](https://kind.sigs.k8s.io/) | `brew install kind` / [releases](https://github.com/kubernetes-sigs/kind/releases) |
| [Docker](https://docs.docker.com/get-docker/) | Required for Kind |
| [Helm](https://helm.sh/docs/intro/install/) | Required internally by Pulumi |

## Deploy the application

### 1. Create a local Kubernetes cluster (Kind)

```sh
kind create cluster --name guestbook
```

### 2. Install dependencies

```sh
npm install
```

### 3. Create a Pulumi stack

```sh
pulumi stack init testbook
```

### 4. Configure the stack

Running on a local Kind cluster (no cloud LoadBalancer):

```sh
pulumi config set isMinikube false
```

### 5. Deploy

```sh
pulumi up
```

Pulumi will provision all resources in parallel. The `kube-prometheus-stack` Helm chart (Prometheus + Grafana) can take 3–5 minutes to pull images on the first run. The frontend `LoadBalancer` service will show `<pending>` for its external IP — this is expected on local clusters; use port-forward to access it (see below).

Expected output when complete:

```
Outputs:
    frontendIp            : "<pending – use kubectl port-forward svc/frontend 8080:80>"
    grafanaPassword       : "admin123"
    grafanaPortForwardCmd : "kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80"
    grafanaUrl            : "http://localhost:3000"
    grafanaUser           : "admin"
    prometheusPortForwardCmd: "kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090"
    prometheusUrl         : "http://localhost:9090"
```

---

## Access the Guestbook

Forward the frontend service to your local machine (keep this terminal open):

```sh
kubectl port-forward svc/frontend 8080:80
```

Open: **http://localhost:8080**

---

## Grafana access

### URL and credentials

| Field | Value |
|-------|-------|
| URL | **http://localhost:3000** |
| Username | `admin` |
| Password | `admin123` |

### Start port-forward

```sh
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
```

Open **http://localhost:3000** and log in with the credentials above.

### Pre-built dashboard

Navigate to **Dashboards → Guestbook → Guestbook Monitoring**. It contains four panels:

| Panel | Metric source |
|-------|--------------|
| Redis Connected Clients | `redis_connected_clients` (redis_exporter) |
| Redis Memory Used | `redis_memory_used_bytes` (redis_exporter) |
| Pod CPU Usage | `container_cpu_usage_seconds_total` (cAdvisor) |
| Pod Memory Usage | `container_memory_usage_bytes` (cAdvisor) |

---

## Verify Prometheus is scraping Guestbook metrics

### 1. Open the Prometheus UI

```sh
kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open **http://localhost:9090**.

### 2. Check ServiceMonitor targets

Navigate to **Status → Targets**. Look for the scrape pool `serviceMonitor/default/redis-guestbook/0` — one for `redis-leader` and one for `redis-replica`. Both should show **State: UP**.

> The `/0` suffix is the endpoint index assigned by Prometheus Operator (our ServiceMonitor defines a single endpoint).

### 3. Query a Redis metric

In the **Graph** tab, run:

```promql
redis_connected_clients
```

You should see one time-series per Redis instance. Try also:

```promql
redis_memory_used_bytes

# redis_commands_total has a "cmd" label — sum to get total throughput per instance
sum(rate(redis_commands_total[1m])) by (instance)
```

### 4. Check pod-level metrics via kube-state-metrics

```promql
sum(rate(container_cpu_usage_seconds_total{namespace="default",container!=""}[5m])) by (pod)
```

This returns CPU usage for every Guestbook pod (frontend, redis-leader, redis-replica).

### 5. Verify from the CLI

```sh
# List all active scrape targets
kubectl exec -n monitoring \
  $(kubectl get pod -n monitoring -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}') \
  -- wget -qO- http://localhost:9090/api/v1/targets \
  | python3 -m json.tool | grep '"job"\|"health"'
```

---

## Destroy

```sh
pulumi destroy
kind delete cluster --name guestbook
```
