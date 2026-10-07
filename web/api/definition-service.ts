import type { DefinitionRepository } from "../data/definitions";

export type DefinitionService = Pick<DefinitionRepository, "list" | "get" | "create" | "updateDraft" | "publish" | "archive" | "getVersion">;
