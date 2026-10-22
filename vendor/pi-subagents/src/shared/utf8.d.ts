export declare function decodeUtf8Tail(bytes: Buffer): string;
export declare function utf8Tail(value: string, maxBytes: number): {
    text: string;
    truncated: boolean;
};
