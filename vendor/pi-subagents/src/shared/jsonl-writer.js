import * as fs from "node:fs";
const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;
export function createJsonlWriter(filePath, source, deps = {}) {
    if (!filePath) {
        return {
            writeLine() { },
            async close() { },
        };
    }
    const createWriteStream = deps.createWriteStream ?? ((targetPath) => fs.createWriteStream(targetPath, { flags: "a" }));
    let stream;
    try {
        stream = createWriteStream(filePath);
    }
    catch {
        return {
            writeLine() { },
            async close() { },
        };
    }
    let backpressured = false;
    let closed = false;
    let bytesWritten = 0;
    const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
    // The mirror is best effort: a stream that cannot open or write (for example
    // because its directory was removed) must not surface as an uncaught error.
    stream.on?.("error", () => {
        closed = true;
        stream = undefined;
        if (backpressured) {
            backpressured = false;
            source.resume();
        }
    });
    return {
        writeLine(line) {
            if (!stream || closed || !line.trim())
                return;
            const chunk = `${line}\n`;
            const chunkBytes = Buffer.byteLength(chunk, "utf-8");
            if (bytesWritten + chunkBytes > maxBytes)
                return;
            try {
                const ok = stream.write(chunk);
                bytesWritten += chunkBytes;
                if (!ok && !backpressured) {
                    backpressured = true;
                    source.pause();
                    stream.once("drain", () => {
                        backpressured = false;
                        if (!closed)
                            source.resume();
                    });
                }
            }
            catch { }
        },
        async close() {
            if (!stream || closed)
                return;
            closed = true;
            const current = stream;
            stream = undefined;
            await new Promise((resolve) => current.end(() => resolve()));
        },
    };
}
//# sourceMappingURL=jsonl-writer.js.map