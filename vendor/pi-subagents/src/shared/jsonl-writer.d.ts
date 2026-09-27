export interface DrainableSource {
    pause(): void;
    resume(): void;
}
export interface JsonlWriteStream {
    write(chunk: string): boolean;
    once(event: "drain", listener: () => void): JsonlWriteStream;
    on?(event: "error", listener: (error: Error) => void): JsonlWriteStream;
    end(callback?: () => void): void;
}
interface JsonlWriterDeps {
    createWriteStream?: (filePath: string) => JsonlWriteStream;
    maxBytes?: number;
}
interface JsonlWriter {
    writeLine(line: string): void;
    close(): Promise<void>;
}
export declare function createJsonlWriter(filePath: string | undefined, source: DrainableSource, deps?: JsonlWriterDeps): JsonlWriter;
export {};
//# sourceMappingURL=jsonl-writer.d.ts.map