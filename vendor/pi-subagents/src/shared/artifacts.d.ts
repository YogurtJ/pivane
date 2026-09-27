import { type ArtifactPaths, type ArtifactDirPreference } from "./types.ts";
export declare const PROJECT_SUBAGENTS_RELATIVE_DIR = ".pi/subagents";
/** Returns a package-publishing warning when project artifacts can enter npm packages. */
export declare function getProjectArtifactPackagingWarning(cwd: string): string | undefined;
export declare function getProjectSubagentsDir(cwd: string): string;
export declare function getProjectArtifactsDir(cwd: string): string;
export declare function getProjectChainRunsDir(cwd: string): string;
export declare function getChainRunsDir(projectCwd: string, dirPreference?: ArtifactDirPreference): string;
export declare function getArtifactsDir(sessionFile: string | null, projectCwd?: string, dirPreference?: ArtifactDirPreference): string;
export declare function getArtifactPaths(artifactsDir: string, runId: string, agent: string, index?: number): ArtifactPaths;
export declare function ensureArtifactsDir(dir: string): void;
export declare function writeArtifact(filePath: string, content: string): void;
export declare function formatOutputArtifactContent(input: {
    output: string;
    error?: string;
    transcriptPath?: string;
    metadataPath?: string;
}): string;
export declare function writeMetadata(filePath: string, metadata: object): void;
export declare function appendJsonl(filePath: string, line: string): void;
export declare function cleanupOldArtifacts(dir: string, maxAgeDays: number): void;
export declare function cleanupAllArtifactDirs(maxAgeDays: number): void;
//# sourceMappingURL=artifacts.d.ts.map