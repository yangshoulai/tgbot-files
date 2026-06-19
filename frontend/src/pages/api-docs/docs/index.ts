import type { SessionResponse } from "../../../api";
import type { DocAudience, DocGroup } from "../types";
import { buildAdminGroup } from "./admin";
import { buildApiKeyGroup } from "./api-key";
import { createDocsContext } from "./context";
import { buildPublicGroup } from "./public";

export function buildDocs(session: SessionResponse): Record<DocAudience, DocGroup> {
  const ctx = createDocsContext(session);
  return {
    "api-key": buildApiKeyGroup(ctx),
    admin: buildAdminGroup(ctx),
    public: buildPublicGroup(ctx)
  };
}
