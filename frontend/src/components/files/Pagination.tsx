import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Pagination as PaginationType } from "../../api";
import { IconButton } from "../ui/IconButton";

interface PaginationProps {
  pagination: PaginationType;
  onPage: (page: number) => void;
  onLimitChange: (limit: number) => void;
}

const LIMIT_OPTIONS = [20, 50];

export function Pagination({ pagination, onPage, onLimitChange }: PaginationProps) {
  const { page, total, total_pages: totalPages, limit } = pagination;
  return (
    <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
      <div className="flex flex-wrap items-center justify-center gap-3 sm:justify-start">
        <p className="text-xs text-muted">
          共 <span className="text-foreground">{total}</span> 个文件
        </p>
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          每页
          <select
            value={limit}
            onChange={(event) => onLimitChange(Number(event.target.value))}
            className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-foreground shadow-card outline-none transition-colors hover:border-border-strong focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]"
          >
            {LIMIT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <IconButton
          variant="default"
          size="sm"
          label="上一页"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <span className="min-w-16 text-center text-xs text-muted">
          <span className="text-foreground">{page}</span> / {totalPages}
        </span>
        <IconButton
          variant="default"
          size="sm"
          label="下一页"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>
    </div>
  );
}
