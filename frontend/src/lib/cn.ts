export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | Record<string, boolean | null | undefined>
  | ClassValue[];

export function cn(...values: ClassValue[]): string {
  const parts: string[] = [];

  for (const value of values) {
    if (!value) continue;

    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      continue;
    }

    if (Array.isArray(value)) {
      const nested = cn(...value);
      if (nested) parts.push(nested);
      continue;
    }

    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        if (value[key]) parts.push(key);
      }
    }
  }

  return parts.join(" ");
}
