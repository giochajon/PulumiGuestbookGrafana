# PulumiGuestbookGrafana

A [Pulumi](https://www.pulumi.com/) TypeScript project that deploys the classic [Kubernetes Guestbook](https://kubernetes.io/docs/tutorials/stateless-application/guestbook/) application and extends it with a full observability stack using **Prometheus** and **Grafana**, including a pre-built dashboard for Guestbook metrics.

## Architecture

```
default namespace
├── frontend (3 replicas)  ← PHP guestbook UI (LoadBalancer / ClusterIP)
├── redis-leader           ← Redis primary + redis_exporter sidecar (:9121/metrics)
└── redis-replica          ← Redis replica  + redis_exporter sidecar (:9121/metrics)

monitoring namespace
├── prometheus             ← Scrapes redis_exporter (ServiceMonitor) + pod/node metrics
└── grafana                ← NodePort :32000 — pre-loaded "Guestbook Monitoring" dashboard
```

Metrics flow:
- **Redis metrics** → collected by `redis_exporter` sidecars → scraped by Prometheus via `ServiceMonitor/redis-guestbook`
- **Pod CPU / Memory** → collected by kubelet cAdvisor (bundled in `kube-prometheus-stack`) → visualised in the dashboard

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | ≥ 18 | `brew install node` / `apt install nodejs` |
| [Pulumi CLI](https://www.pulumi.com/docs/get-started/install/) | latest | `curl -fsSL https://get.pulumi.com \| sh` |
| [kubectl](https://kubernetes.io/docs/tasks/tools/) | latest | `brew install kubectl` / `apt install kubectl` |
| [Kind](https://kind.sigs.k8s.io/) | latest | `brew install kind` / [releases](https://github.com/kubernetes-sigs/kind/releases) |
| [Docker](https://docs.docker.com/get-docker/) | latest | required by Kind |
| [Helm](https://helm.sh/docs/intro/install/) | ≥ 3 | used internally by Pulumi |

---

## Deploy the Application

All Pulumi source lives in the [`simple/`](simple/) directory.

### 1. Create a local Kubernetes cluster

```sh
kind create cluster --name guestbook
```

### 2. Install Node dependencies

```sh
cd simple
npm install
```

### 3. Initialise a Pulumi stack

```sh
pulumi stack init testbook
```

### 4. Configure the stack

For a local Kind cluster (no cloud load-balancer):

```sh
pulumi config set isMinikube false
```

> Set `isMinikube true` only on a real Minikube cluster — it switches the frontend service to ClusterIP.

### 5. Deploy

```sh
pulumi up
```

The `kube-prometheus-stack` Helm chart pulls several images on first run; allow **3–5 minutes** to complete. Confirm with `yes` when prompted.

Expected outputs when complete:

```
Outputs:
    frontendIp               : "<pending – use kubectl port-forward svc/frontend 8080:80>"
    grafanaPassword          : "admin123"
    grafanaPortForwardCmd    : "kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80"
    grafanaUrl               : "http://localhost:3000"
    grafanaUser              : "admin"
    prometheusPortForwardCmd : "kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090"
    prometheusUrl            : "http://localhost:9090"
```

---

## Access the Guestbook

```sh
kubectl port-forward svc/frontend 8080:80
```

Open **[http://localhost:8080](http://localhost:8080)**

---

## Grafana Access

### Credentials

| Field    | Value                  |
|----------|------------------------|
| URL      | **http://localhost:3000** |
| Username | `admin`               |
| Password | `admin123`            |

### Port-forward Grafana

```sh
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
```

Open **[http://localhost:3000](http://localhost:3000)** and sign in.

### Pre-built Dashboard

Navigate to **Dashboards → Guestbook → Guestbook Monitoring**.

| Panel | PromQL source |
|-------|---------------|
| Redis Connected Clients | `redis_connected_clients` (redis_exporter) |
| Redis Memory Used | `redis_memory_used_bytes` (redis_exporter) |
| Pod CPU Usage (default ns) | `container_cpu_usage_seconds_total` (cAdvisor) |
| Pod Memory Usage (default ns) | `container_memory_usage_bytes` (cAdvisor) |

---

## Verify Prometheus Is Scraping Guestbook Metrics

### 1. Open the Prometheus UI

```sh
kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open **[http://localhost:9090](http://localhost:9090)**.

### 2. Check scrape targets

Go to **Status → Targets** and look for the scrape pool `serviceMonitor/default/redis-guestbook/0`. You should see two entries — one for `redis-leader` and one for `redis-replica` — both with **State: UP**.

> The `/0` suffix is the endpoint index assigned by Prometheus Operator (our ServiceMonitor defines a single endpoint).

### 3. Query Redis metrics

In the **Graph** tab, run any of the following:

```promql
# Number of connected clients per Redis instance
redis_connected_clients

# Memory allocated by Redis
redis_memory_used_bytes

# Total command throughput per instance (rate over 1 min)
# redis_commands_total has a "cmd" label — sum across all command types
sum(rate(redis_commands_total[1m])) by (instance)
```

### 4. Query pod resource metrics

```promql
# CPU usage rate per Guestbook pod
sum(rate(container_cpu_usage_seconds_total{namespace="default",container!=""}[5m])) by (pod)

# Memory usage per Guestbook pod
sum(container_memory_usage_bytes{namespace="default",container!=""}) by (pod)
```

### 5. Verify targets via CLI

```sh
kubectl exec -n monitoring \
  $(kubectl get pod -n monitoring -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}') \
  -- wget -qO- http://localhost:9090/api/v1/targets \
  | python3 -m json.tool | grep -E '"job"|"health"'
```

All `redis-guestbook` jobs should report `"health": "up"`.

---

## Pulumi Outputs Reference

| Output | Description |
|--------|-------------|
| `frontendIp` | External IP of the frontend service (pending on local clusters) |
| `grafanaUrl` | Grafana UI URL (after port-forward) |
| `grafanaUser` | Grafana admin username |
| `grafanaPassword` | Grafana admin password |
| `grafanaPortForwardCmd` | Full command to port-forward Grafana |
| `prometheusUrl` | Prometheus UI URL (after port-forward) |
| `prometheusPortForwardCmd` | Full command to port-forward Prometheus |

---

## Tear Down

```sh
pulumi destroy
kind delete cluster --name guestbook
```
