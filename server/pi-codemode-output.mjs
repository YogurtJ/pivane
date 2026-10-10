// Result-only SDK adaptation. The official sandbox still owns execution, limits,
// cancellation, calls, store writes and errors. Images retain the native path.
import { CodemodeSandbox as NativeSandbox } from '@earendil-works/pi-codemode';
export * from '@earendil-works/pi-codemode';

// Below this size, retain the original result unchanged. This is a formatting
// threshold, not an output limit or a change to what the sandbox may emit.
const LINEAR_OUTPUT_MIN_ITEMS = 256;
export function compactCodemodeTextOutput(result) {
    const output = result.output;
    if (output.length < LINEAR_OUTPUT_MIN_ITEMS || output.some(item => item.type !== 'text')) return result;
    const returned = result.ok && result.value !== undefined;
    const value = returned ? (typeof result.value === 'string' ? result.value : JSON.stringify(result.value) ?? String(result.value)) : undefined;
    const total = output.filter(item => !item.console).length + (returned ? 1 : 0);
    const parts = [], consoleLines = [];
    let index = 0, empty = true, endsWithNewline = false;
    const append = text => {
        if (!empty && !endsWithNewline) { parts.push('\n'); endsWithNewline = true; }
        parts.push(text);
        if (text.length) { empty = false; endsWithNewline = text.endsWith('\n'); }
    };
    const textItem = text => { index++; append(total > 1 ? `==> text ${index}/${total} <==\n${text}` : text); };
    for (const item of output) {
        if (item.console) consoleLines.push(item.text);
        else textItem(item.text);
    }
    if (returned) textItem(value);
    if (consoleLines.length) append(`<console_output>\n${consoleLines.join('\n')}\n</console_output>`);
    return { ...result, output: [{ type: 'text', text: parts.join('') }], ...(returned ? { value: undefined } : {}) };
}

export class CodemodeSandbox extends NativeSandbox {
    async execute(code, options) {
        return compactCodemodeTextOutput(await super.execute(code, options));
    }
}
