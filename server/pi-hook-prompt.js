// Keep run-specific additions in native sections so tool/loadout changes can still
// update the prompt. An earlier explicit forced prompt is opaque to Pi's renderer;
// preserve its exact prefix and the historical suffix as well as the transcript section.
function setPromptSection(event, name, content, { wrapForced = false } = {}) {
    const options = event.systemPromptOptions;
    options.sections[name] = content;
    if (options.forceSystemPrompt !== undefined) {
        const suffix = wrapForced ? `<${name}>\n${content}\n</${name}>` : content;
        options.forceSystemPrompt += '\n\n' + suffix;
    }
}

module.exports = { setPromptSection };
