import type { FileRepository } from "../data/files";

export type FileService = Pick<FileRepository, "begin" | "list" | "get" | "putChunk" | "readChunk" | "seal" | "cancel" | "cancelUnavailable">;
export function postgresFileService(repository: FileRepository): FileService { return repository; }
