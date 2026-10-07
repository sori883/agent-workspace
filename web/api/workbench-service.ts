import type { WorkbenchRepository } from "../data/workbench";
export type WorkbenchService = Pick<WorkbenchRepository, "start" | "answer" | "list" | "get" | "stop" | "recover">;
