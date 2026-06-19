import type { ParameterDoc, RequiredMark } from "./types";

export function p(
  name: string,
  location: ParameterDoc["location"],
  required: RequiredMark,
  type: string,
  limit: string,
  description: string
): ParameterDoc {
  return { name, location, required, type, limit, description };
}
