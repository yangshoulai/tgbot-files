import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, Search } from "lucide-react";
import type { DirectoryItem } from "../../api";
import { cn } from "../../lib/cn";

interface DirectoryTreeSelectProps {
  id?: string;
  value: string;
  directories: DirectoryItem[];
  onChange: (path: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  emptyText?: string;
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

export function DirectoryTreeSelect({
  id,
  value,
  directories,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "选择目录",
  emptyText = "没有可选子目录"
}: DirectoryTreeSelectProps) {
  const searchId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(["/"]));
  const tree = useMemo(() => buildDirectoryTree(directories), [directories]);
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePaths = useMemo(
    () => visibleDirectoryPaths(tree, normalizedQuery),
    [tree, normalizedQuery]
  );

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

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

  const selectedLabel = value === "/" ? "/ 根目录" : value || placeholder;

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

  function selectPath(path: string) {
    onChange(path);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        id={id}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="tree"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 text-left text-sm text-foreground shadow-card outline-none transition-colors",
          "hover:border-border-strong hover:bg-background focus:border-primary focus:shadow-[0_0_0_4px_var(--color-primary-ring)]",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {value === "/" ? <FolderOpen size={16} className="shrink-0 text-primary" /> : <Folder size={16} className="shrink-0 text-primary" />}
          <span className="truncate font-medium">{selectedLabel}</span>
        </span>
        <ChevronDown
          size={16}
          className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-2 w-full min-w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface shadow-dialog animate-fade-in sm:min-w-96">
          <div className="border-b border-border p-2">
            <label htmlFor={searchId} className="sr-only">
              搜索目录
            </label>
            <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-2 text-sm text-muted focus-within:border-primary focus-within:shadow-[0_0_0_4px_var(--color-primary-ring)]">
              <Search size={14} className="shrink-0" />
              <input
                id={searchId}
                value={query}
                placeholder="搜索目录路径"
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
              />
            </div>
          </div>

          <div role="tree" aria-label={ariaLabel} className="max-h-[min(24rem,52dvh)] overflow-auto p-1.5 scroll-thin">
            <DirectoryTreeRow
              node={tree}
              selectedPath={value}
              expandedPaths={expandedPaths}
              visiblePaths={visiblePaths}
              searching={Boolean(normalizedQuery)}
              onToggle={togglePath}
              onSelect={selectPath}
            />
            {directories.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted">{emptyText}</p>
            ) : null}
            {directories.length > 0 && visiblePaths.size === 1 && normalizedQuery ? (
              <p className="px-3 py-2 text-xs text-muted">没有匹配的目录</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DirectoryTreeRow({
  node,
  selectedPath,
  expandedPaths,
  visiblePaths,
  searching,
  onToggle,
  onSelect
}: {
  node: TreeNode;
  selectedPath: string;
  expandedPaths: Set<string>;
  visiblePaths: Set<string>;
  searching: boolean;
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
        className={cn(
          "group flex items-center gap-1 rounded-lg pr-2 text-sm transition-colors",
          selected ? "bg-primary-soft text-primary-strong" : "text-foreground hover:bg-background"
        )}
        style={{ paddingLeft: 6 + node.depth * 18 }}
      >
        <button
          type="button"
          aria-label={hasChildren ? (expanded ? "收起目录" : "展开目录") : "无子目录"}
          disabled={!hasChildren}
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
          onClick={() => onSelect(node.path)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left focus-visible:outline-none focus-visible:focus-ring"
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
