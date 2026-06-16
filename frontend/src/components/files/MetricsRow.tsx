import { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface Metric {
  label: string;
  value: string;
  hint?: string;
  icon?: ReactNode;
}

interface MetricsRowProps {
  metrics: Metric[];
  className?: string;
}

export function MetricsRow({ metrics, className }: MetricsRowProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5",
        className
      )}
    >
      {metrics.map((metric) => (
        <article
          key={metric.label}
          className="rounded-2xl border border-border bg-surface p-4 shadow-card transition-shadow duration-150 hover:shadow-card-hover"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">{metric.label}</p>
            {metric.icon ? <span className="text-subtle">{metric.icon}</span> : null}
          </div>
          <p className="mt-3 truncate text-2xl font-semibold text-foreground" title={metric.value}>
            {metric.value}
          </p>
          {metric.hint ? <p className="mt-1 truncate text-xs text-muted">{metric.hint}</p> : null}
        </article>
      ))}
    </div>
  );
}
