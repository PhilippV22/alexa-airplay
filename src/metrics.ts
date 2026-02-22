import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { NextFunction, Request, Response } from "express";

export class MetricsService {
  public readonly registry: Registry;
  private readonly requestCounter: Counter<string>;
  private readonly requestDuration: Histogram<string>;
  private readonly activeTargetGauge: Gauge<string>;
  private readonly activeSessionGauge: Gauge<string>;
  private readonly activeProcessGauge: Gauge<string>;
  private readonly reconcilesCounter: Counter<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.requestCounter = new Counter({
      name: "airbridge_http_requests_total",
      help: "Total HTTP requests",
      labelNames: ["method", "route", "status"],
      registers: [this.registry],
    });

    this.requestDuration = new Histogram({
      name: "airbridge_http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status"],
      buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    this.activeTargetGauge = new Gauge({
      name: "airbridge_active_targets",
      help: "Number of active targets",
      registers: [this.registry],
    });

    this.activeSessionGauge = new Gauge({
      name: "airbridge_active_sessions",
      help: "Number of active sessions",
      registers: [this.registry],
    });

    this.activeProcessGauge = new Gauge({
      name: "airbridge_active_processes",
      help: "Number of active child processes",
      registers: [this.registry],
    });

    this.reconcilesCounter = new Counter({
      name: "airbridge_reconcile_total",
      help: "Total number of reconcile loops",
      labelNames: ["result"],
      registers: [this.registry],
    });
  }

  httpMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const route = req.route?.path ?? req.path;
    const end = this.requestDuration.startTimer({ method: req.method, route });

    res.on("finish", () => {
      const status = String(res.statusCode);
      this.requestCounter.inc({ method: req.method, route, status });
      end({ status });
    });

    next();
  };

  setActiveTargets(value: number): void {
    this.activeTargetGauge.set(value);
  }

  setActiveSessions(value: number): void {
    this.activeSessionGauge.set(value);
  }

  setActiveProcesses(value: number): void {
    this.activeProcessGauge.set(value);
  }

  incReconcile(result: "success" | "failure"): void {
    this.reconcilesCounter.inc({ result });
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }
}
