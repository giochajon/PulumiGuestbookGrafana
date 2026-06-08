// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube");
const grafanaAdminPassword = config.requireSecret("grafanaAdminPassword");

// ---------------------------------------------------------------------------
// REDIS LEADER  (+ redis_exporter sidecar for Prometheus metrics)
// ---------------------------------------------------------------------------

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: {
                labels: redisLeaderLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9121",
                },
            },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.66.0",
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
                        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
                    },
                ],
            },
        },
    },
});

const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: { app: "redis-leader" },
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 },
        ],
        selector: redisLeaderLabels,
    },
});

// ---------------------------------------------------------------------------
// REDIS REPLICA  (+ redis_exporter sidecar)
// ---------------------------------------------------------------------------

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: {
                labels: redisReplicaLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9121",
                },
            },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.66.0",
                        resources: { requests: { cpu: "50m", memory: "64Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
                        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
                    },
                ],
            },
        },
    },
});

const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: { app: "redis-replica" },
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 },
        ],
        selector: redisReplicaLabels,
    },
});

// ---------------------------------------------------------------------------
// FRONTEND
// ---------------------------------------------------------------------------

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "80",
                },
            },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80 }],
                    },
                ],
            },
        },
    },
});

const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        name: "frontend",
        labels: { app: "frontend" },
        // Skip waiting for a cloud LoadBalancer IP; on local clusters (Kind)
        // none will be assigned. Access via kubectl port-forward instead.
        annotations: { "pulumi.com/skipAwait": "true" },
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [{ port: 80 }],
        selector: frontendLabels,
    },
});

export let frontendIp: pulumi.Output<string>;
if (isMinikube) {
    frontendIp = frontendService.spec.clusterIP;
} else {
    frontendIp = frontendService.status.apply(s => {
        const ingress = s?.loadBalancer?.ingress;
        return ingress && ingress.length > 0 && ingress[0].ip
            ? ingress[0].ip
            : "<pending – use kubectl port-forward svc/frontend 8080:80>";
    });
}

// ---------------------------------------------------------------------------
// MONITORING NAMESPACE
// ---------------------------------------------------------------------------

const monitoringNs = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// ---------------------------------------------------------------------------
// GRAFANA DASHBOARD  (auto-provisioned via Helm values)
// ---------------------------------------------------------------------------

const guestbookDashboardJson = JSON.stringify({
    title: "Guestbook Monitoring",
    uid: "guestbook-monitoring",
    timezone: "browser",
    refresh: "10s",
    schemaVersion: 38,
    tags: ["guestbook"],
    time: { from: "now-1h", to: "now" },
    panels: [
        {
            id: 1,
            title: "Redis Connected Clients",
            type: "timeseries",
            datasource: { type: "prometheus" },
            gridPos: { h: 8, w: 12, x: 0, y: 0 },
            targets: [{ expr: "redis_connected_clients", legendFormat: "{{job}}" }],
            options: { tooltip: { mode: "single" }, legend: { displayMode: "list", placement: "bottom" } },
        },
        {
            id: 2,
            title: "Redis Memory Used",
            type: "timeseries",
            datasource: { type: "prometheus" },
            gridPos: { h: 8, w: 12, x: 12, y: 0 },
            fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
            targets: [{ expr: "redis_memory_used_bytes", legendFormat: "{{job}}" }],
            options: { tooltip: { mode: "single" }, legend: { displayMode: "list", placement: "bottom" } },
        },
        {
            id: 3,
            title: "Pod CPU Usage (default ns)",
            type: "timeseries",
            datasource: { type: "prometheus" },
            gridPos: { h: 8, w: 12, x: 0, y: 8 },
            targets: [{
                expr: `sum(rate(container_cpu_usage_seconds_total{namespace="default",container!=""}[5m])) by (pod)`,
                legendFormat: "{{pod}}",
            }],
            options: { tooltip: { mode: "multi" }, legend: { displayMode: "list", placement: "bottom" } },
        },
        {
            id: 4,
            title: "Pod Memory Usage (default ns)",
            type: "timeseries",
            datasource: { type: "prometheus" },
            gridPos: { h: 8, w: 12, x: 12, y: 8 },
            fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
            targets: [{
                expr: `sum(container_memory_usage_bytes{namespace="default",container!=""}) by (pod)`,
                legendFormat: "{{pod}}",
            }],
            options: { tooltip: { mode: "multi" }, legend: { displayMode: "list", placement: "bottom" } },
        },
    ],
});

// ---------------------------------------------------------------------------
// KUBE-PROMETHEUS-STACK  (Prometheus Operator + Grafana via Helm)
// ---------------------------------------------------------------------------

const prometheusStack = new k8s.helm.v3.Release("prometheus-stack", {
    name: "monitoring",
    chart: "kube-prometheus-stack",
    namespace: monitoringNs.metadata.name,
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    timeout: 600,
    values: {
        grafana: {
            adminPassword: grafanaAdminPassword,
            service: {
                type: "NodePort",
                nodePort: 32000,
            },
            dashboardProviders: {
                "dashboardproviders.yaml": {
                    apiVersion: 1,
                    providers: [{
                        name: "guestbook",
                        orgId: 1,
                        folder: "Guestbook",
                        type: "file",
                        disableDeletion: false,
                        editable: true,
                        options: { path: "/var/lib/grafana/dashboards/guestbook" },
                    }],
                },
            },
            dashboards: {
                guestbook: {
                    "guestbook-monitoring": {
                        json: guestbookDashboardJson,
                    },
                },
            },
        },
        prometheus: {
            prometheusSpec: {
                // Allow scraping ServiceMonitors from any namespace with any labels.
                serviceMonitorSelectorNilUsesHelmValues: false,
                serviceMonitorSelector: {},
                serviceMonitorNamespaceSelector: {},
            },
        },
        // AlertManager, scheduler, etcd, and controller-manager metrics are not
        // accessible in Kind clusters; disable to prevent spurious alerts.
        alertmanager: { enabled: false },
        kubeScheduler: { enabled: false },
        kubeControllerManager: { enabled: false },
        kubeEtcd: { enabled: false },
        kubeProxy: { enabled: false },
        // Admission webhooks require TLS; skip for local clusters.
        prometheusOperator: {
            admissionWebhooks: {
                enabled: false,
                patch: { enabled: false },
            },
            tls: { enabled: false },
        },
    },
}, { dependsOn: [monitoringNs] });

// ---------------------------------------------------------------------------
// REDIS SERVICE MONITOR  (tells Prometheus to scrape the redis-exporter)
// ---------------------------------------------------------------------------

const redisServiceMonitor = new k8s.apiextensions.CustomResource("redis-service-monitor", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
        name: "redis-guestbook",
        namespace: "default",
    },
    spec: {
        selector: {
            matchExpressions: [{
                key: "app",
                operator: "In",
                values: ["redis-leader", "redis-replica"],
            }],
        },
        endpoints: [{
            port: "metrics",
            interval: "15s",
            path: "/metrics",
        }],
    },
}, { dependsOn: [prometheusStack, redisLeaderService, redisReplicaService] });

// ---------------------------------------------------------------------------
// OUTPUTS
// ---------------------------------------------------------------------------

export const grafanaUrl = "http://localhost:3000";
export const grafanaUser = "admin";
export const grafanaPassword = grafanaAdminPassword;
export const grafanaPortForwardCmd = "kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80";
export const prometheusUrl = "http://localhost:9090";
export const prometheusPortForwardCmd = "kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090";
