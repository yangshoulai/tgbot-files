import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronRight, Folder, FolderOpen, Search } from "lucide-react";
import type { DirectoryItem } from "../../api";
import { cn } from "../../lib/cn";

interface DirectoryTreeProps {
  id?: string;
  value: string;
  directories: DirectoryItem[];
  onChange: (path: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  emptyText?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  className?: string;
  treeClassName?: string;
}

interface TreeNode {
  id: string | null;
  name: string;
  path: string;
  depth: number;
  children: TreeNode[];
}

const ROOT_NODE: TreeNode = {
  id: null,
  name: "/ 根目录",
  path: "/",
  depth: 0,
  children: []
};

export function DirectoryTree({
  id,
  value,
  directories,
  onChange,
  ariaLabel,
  disabled = false,
  emptyText = "没有可选子目录",
  searchable = true,
  searchPlaceholder = "搜索目录路径",
  className,
  treeClassName
}: DirectoryTreeProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["/"]));
  const tree = useMemo(() => buildDirectoryTree(directories), [directories]);
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePaths = useMemo(
    () => visibleDirectoryPaths(tree, normalizedQuery),
    [tree, normalizedQuery]
  );

  useEffect(() => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      next.add("/");
      for (const path of ancestorPaths(value)) {
        next.add(path);
      }
      return next;
    });
  }, [value]);

  function togglePath(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      next.add("/");
      return next;
    });
  }

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border bg-surface shadow-card", className)}>
      {searchable ? (
        <div className="border-b border-border p-2">
          <label htmlFor={searchId} className="sr-only">
            搜索目录
          </label>
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2 text-sm text-muted focus-within:border-primary focus-within:shadow-[0_0_0_4px_var(--color-primary-ring)]">
            <Search size={14} className="shrink-0" />
            <input
              id={searchId}
              value={query}
              placeholder={searchPlaceholder}
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        </div>
      ) : null}

      <div
        id={id}
        role="tree"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        className={cn("max-h-[min(26rem,54dvh)] overflow-auto p-1.5 scroll-thin", treeClassName)}
      >
        <DirectoryTreeRow
          node={tree}
          selectedPath={value}
          expandedPaths={expandedPaths}
          visiblePaths={visiblePaths}
          searching={Boolean(normalizedQuery)}
          disabled={disabled}
          onToggle={togglePath}
          onSelect={onChange}
        />
        {directories.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted">{emptyText}</p>
        ) : null}
        {directories.length > 0 && visiblePaths.size === 1 && normalizedQuery ? (
          <p className="px-3 py-2 text-xs text-muted">没有匹配的目录</p>
        ) : null}
      </div>
    </div>
  );
}

function DirectoryTreeRow({
  node,
  selectedPath,
  expandedPaths,
  visiblePaths,
  searching,
  disabled,
  onToggle,
  onSelect
}: {
  node: TreeNode;
  selectedPath: string;
  expandedPaths: Set<string>;
  visiblePaths: Set<string>;
  searching: boolean;
  disabled: boolean;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (!visiblePaths.has(node.path)) {
    return null;
  }

  const hasChildren = node.children.some((child) => visiblePaths.has(child.path));
  const expanded = searching || expandedPaths.has(node.path);
  const selected = selectedPath === node.path;

  return (
    <div role="none">
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-disabled={disabled || undefined}
        className={cn(
          "group flex items-center gap-1 rounded-lg pr-2 text-sm transition-colors",
          selected ? "bg-primary-soft text-primary-strong" : "text-foreground hover:bg-background",
          disabled && "opacity-60"
        )}
        style={{ paddingLeft: 6 + node.depth * 18 }}
      >
        <button
          type="button"
          aria-label={hasChildren ? (expanded ? "收起目录" : "展开目录") : "无子目录"}
          disabled={disabled || !hasChildren}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.path);
          }}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-primary-soft hover:text-primary-strong disabled:opacity-0"
        >
          <ChevronRight size={14} className={cn("transition-transform", expanded && "rotate-90")} />
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSelect(node.path)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus-visible:outline-none focus-visible:focus-ring disabled:cursor-not-allowed"
        >
          {expanded && hasChildren ? <FolderOpen size={16} className="shrink-0" /> : <Folder size={16} className="shrink-0" />}
          <span className="truncate font-medium">{node.name}</span>
          {node.path !== "/" ? <span className="hidden truncate text-xs text-muted sm:inline">{node.path}</span> : null}
        </button>
        {selected ? <Check size={15} className="shrink-0" /> : null}
      </div>

      {hasChildren && expanded ? (
        <div role="group">
          {node.children.map((child) => (
            <DirectoryTreeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              visiblePaths={visiblePaths}
              searching={searching}
              disabled={disabled}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildDirectoryTree(directories: DirectoryItem[]): TreeNode {
  const childrenByParent = new Map<string | null, DirectoryItem[]>();
  const byId = new Map(directories.map((directory) => [directory.id, directory]));

  for (const directory of directories) {
    const parentId = directory.parent_id && byId.has(directory.parent_id) ? directory.parent_id : null;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(directory);
    childrenByParent.set(parentId, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  function build(parentId: string | null, depth: number): TreeNode[] {
    return (childrenByParent.get(parentId) ?? []).map((directory) => ({
      id: directory.id,
      name: directory.name,
      path: directory.path,
      depth,
      children: build(directory.id, depth + 1)
    }));
  }

  return {
    ...ROOT_NODE,
    children: build(null, 1)
  };
}

function visibleDirectoryPaths(root: TreeNode, normalizedQuery: string): Set<string> {
  if (!normalizedQuery) {
    return collectPaths(root);
  }

  const visible = new Set<string>(["/"]);

  function visit(node: TreeNode) {
    const matches =
      node.name.toLowerCase().includes(normalizedQuery) ||
      node.path.toLowerCase().includes(normalizedQuery);

    if (matches) {
      visible.add(node.path);
      for (const path of ancestorPaths(node.path)) {
        visible.add(path);
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);
  return visible;
}

function collectPaths(root: TreeNode): Set<string> {
  const paths = new Set<string>();

  function visit(node: TreeNode) {
    paths.add(node.path);
    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);
  return paths;
}

function ancestorPaths(path: string): string[] {
  if (path === "/") {
    return ["/"];
  }

  const paths = ["/"];
  const segments = path.split("/").filter(Boolean);
  let current = "";

  for (let index = 0; index < segments.length - 1; index += 1) {
    current += `/${segments[index]}`;
    paths.push(current);
  }

  return paths;
}
