import { type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
/** A single selectable row. `value` is returned on confirm; `label` is the primary text. */
export interface SelectorItem {
    value: string;
    label: string;
    /** Optional dimmed badge shown after the label (e.g. a provider name). */
    badge?: string;
    /** Marks the current selection (rendered with a ✓ checkmark). */
    current?: boolean;
}
export interface SelectorResult {
    confirmed: boolean;
    value?: string;
}
export interface SelectorOptions {
    title: string;
    /** Optional dimmed hint line under the title (e.g. the current value). */
    subtitle?: string;
    items: SelectorItem[];
    done: (result: SelectorResult) => void;
}
/**
 * A single-select list with a search field and a bounded scroll window that keeps the
 * highlighted row on screen with an `(n/total)` indicator, so the selection never scrolls
 * out of view when the option list is long. Composed from pi's own TUI primitives so it
 * matches the built-in `/model` picker.
 *
 * Colors come from the `theme` passed to the factory: the module-level `theme` singleton
 * is undefined under the extension's jiti module cache.
 */
export declare class SelectorComponent extends Container {
    private readonly tui;
    private readonly theme;
    private readonly keybindings;
    private readonly items;
    private readonly done;
    private readonly searchInput;
    private readonly listContainer;
    private filtered;
    private selectedIndex;
    constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, options: SelectorOptions);
    private applyFilter;
    private updateList;
    private confirmSelection;
    handleInput(keyData: string): void;
}
//# sourceMappingURL=selector.d.ts.map