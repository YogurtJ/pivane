import { declarationsEqual, getCurrentSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
const pinsByApi = new WeakMap();
const GUIDELINES_PLACEHOLDER = "\u0000pi-subagents guidelines";
/**
 * A recorded description without the text a host appends to each declared tool, such as Pi's
 * codemode note on script-callable tools. The host decorates whatever is registered, so reusing a
 * decorated description would add the note again on every session start (#2889). Drops a repeated
 * trailing paragraph, then a trailing paragraph added after the current description.
 */
function undecorated(recorded, current) {
    const paragraphs = recorded.split("\n\n");
    while (paragraphs.length > 1 && paragraphs.at(-1) === paragraphs.at(-2))
        paragraphs.pop();
    const stripped = paragraphs.join("\n\n");
    return stripped.startsWith(`${current}\n\n`) ? current : stripped;
}
function pinnedDefinition(tool, pin) {
    const { constrainedSampling, promptSnippet, promptGuidelines, ...rest } = tool;
    // An unchanged declaration keeps the registered schema object rather than its JSON copy.
    const recorded = pin ? { ...pin.declaration, description: undecorated(pin.declaration.description, rest.description) } : undefined;
    const declaration = recorded && !declarationsEqual(recorded, tool) ? recorded : undefined;
    const definition = { ...rest, description: declaration?.description ?? rest.description, parameters: declaration?.parameters ?? rest.parameters };
    const sampling = declaration ? declaration.constrainedSampling : constrainedSampling;
    if (sampling !== undefined)
        definition.constrainedSampling = sampling;
    const snippet = pin?.snippet ? pin.snippet.text : promptSnippet;
    if (snippet !== undefined)
        definition.promptSnippet = snippet;
    const guidelines = pin?.guidelines ?? promptGuidelines;
    if (guidelines !== undefined)
        definition.promptGuidelines = guidelines;
    return definition;
}
function register(pi, pins, name) {
    const definition = pinnedDefinition(pins.current.get(name), pins.declared.get(name));
    const key = JSON.stringify([toToolDeclaration(definition), definition.promptSnippet, definition.promptGuidelines]);
    if (pins.registered.get(name) === key)
        return;
    pins.registered.set(name, key);
    pi.registerTool(definition);
}
function sectionLines(text, name) {
    const lines = text?.split("\n") ?? [];
    const start = lines.indexOf(`<${name}>`);
    const end = lines.indexOf(`</${name}>`, start + 1);
    return start >= 0 && end > start ? lines.slice(start + 1, end) : undefined;
}
/** Mirrors the unexported buildRules of Pi's default system prompt, without prompt-level guidelines. */
function ruleLines(activeTools, guidelines) {
    const lines = [];
    const add = (rule) => {
        const line = `- ${rule.trim()}`;
        if (line !== "- " && !lines.includes(line))
            lines.push(line);
    };
    const active = (name) => activeTools.includes(name);
    if ((active("bash") || active("powershell")) && !active("grep") && !active("find") && !active("ls")) {
        if (active("bash") && active("powershell"))
            add("Use bash or PowerShell for file operations like listing, searching, and finding files");
        else if (active("powershell"))
            add("Use PowerShell for file operations like listing, searching, and finding files");
        else
            add("Use bash for file operations like ls, rg, find");
    }
    for (const name of activeTools)
        for (const rule of guidelines.get(name) ?? [])
            add(rule);
    add("Be concise in your responses");
    add("Show file paths clearly when working with files");
    return lines;
}
const sameLines = (left, right) => left.length === right.length && left.every((line, index) => line === right[index]);
/**
 * The rules section does not say which tool contributed a bullet, so a declared tool's guidelines
 * are recovered by rebuilding the recorded rules with candidate bullets at that tool's position.
 * Nothing is recovered unless the rebuild first reproduces Pi's current rules.
 */
function recordedGuidelines(pi, ctx, recorded, names) {
    const recovered = new Map();
    const activeTools = pi.getActiveTools();
    const guidelines = new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []]));
    const current = sectionLines(ctx.getSystemPrompt(), "rules");
    if (!current || !sameLines(ruleLines(activeTools, guidelines), current))
        return recovered;
    const rebuild = (name, candidate) => ruleLines(activeTools, new Map(guidelines).set(name, candidate));
    for (const name of names) {
        const start = rebuild(name, [GUIDELINES_PLACEHOLDER]).indexOf(`- ${GUIDELINES_PLACEHOLDER}`);
        if (start < 0)
            continue;
        const candidate = recorded.slice(start, start + recorded.length - rebuild(name, []).length).map((line) => line.slice(2));
        if (!sameLines(rebuild(name, candidate), recorded))
            continue;
        guidelines.set(name, candidate);
        recovered.set(name, candidate);
    }
    return recovered;
}
function recordedSystemMessage(ctx) {
    // SAFETY: Pi's session manager exposes buildSessionContext, but its read-only extension type omits it.
    const sessionManager = ctx?.sessionManager;
    // A host without a readable transcript, such as a test double, declares nothing to keep.
    if (typeof sessionManager?.buildSessionContext !== "function")
        return undefined;
    return getCurrentSystemMessage(sessionManager.buildSessionContext().messages);
}
function declaredPins(pi, pins, ctx, system) {
    if (!ctx || !system)
        return new Map();
    const declarations = system.toolsAdded ?? [];
    const snippets = sectionLines(system.sections?.tools ?? undefined, "tools");
    const rules = sectionLines(system.sections?.rules ?? undefined, "rules");
    const guidelines = rules ? recordedGuidelines(pi, ctx, rules, declarations.map((tool) => tool.name).filter((name) => pins.current.has(name))) : new Map();
    return new Map(declarations.map((declaration) => {
        const pin = { declaration };
        // Pi renders each snippet on one line as "- <tool>: <snippet>".
        if (snippets)
            pin.snippet = { text: snippets.find((line) => line.startsWith(`- ${declaration.name}: `))?.slice(declaration.name.length + 4) };
        const recovered = guidelines.get(declaration.name);
        if (recovered)
            pin.guidelines = recovered;
        return [declaration.name, pin];
    }));
}
function pinsFor(pi) {
    const existing = pinsByApi.get(pi);
    if (existing)
        return existing;
    const pins = { current: new Map(), declared: new Map(), registered: new Map(), sections: {}, pinned: true };
    pinsByApi.set(pi, pins);
    // Pi restores the transcript's active tools before both events, so handler order does not matter.
    const refresh = (ctx) => {
        const system = pins.pinned ? recordedSystemMessage(ctx) : undefined;
        pins.sections = system?.sections ?? {};
        pins.declared = declaredPins(pi, pins, ctx, system);
        for (const name of pins.current.keys())
            register(pi, pins, name);
    };
    pi.on("session_start", (_event, ctx) => refresh(ctx));
    pi.on("session_tree", (_event, ctx) => refresh(ctx));
    return pins;
}
/**
 * The text, without its tags, that the session transcript recorded for one of the prompt sections
 * pi-subagents adds, so that section can keep the wording the session already sent.
 * A session that never recorded the section gets undefined.
 */
export function recordedPromptSection(pi, name) {
    return sectionLines(pinsFor(pi).sections[name] ?? undefined, name)?.join("\n");
}
/**
 * Register a pi-subagents tool so a session keeps the definition, prompt snippet and guidelines
 * its transcript already declared. Only a session that never declared the tool gets this definition.
 */
export function registerPinnedTool(pi, tool) {
    const pins = pinsFor(pi);
    // SAFETY: Pinning reads only model-facing fields and re-registers every runtime field unchanged.
    pins.current.set(tool.name, tool);
    pins.registered.delete(tool.name);
    register(pi, pins, tool.name);
}
/**
 * Choose whether this session keeps the pi-subagents definitions and prompt text its transcript
 * declared (the default) or gets the current ones. Call before registering any pinned tool.
 */
export function setDeclarationPinning(pi, pinned) {
    pinsFor(pi).pinned = pinned;
}
