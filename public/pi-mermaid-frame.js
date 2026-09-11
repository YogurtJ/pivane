// Runs only in an opaque-origin sandbox. No credentials, network APIs or parent DOM access.
(() => {
    let busy = false;
    window.addEventListener('message', async event => {
        if (event.source !== parent || event.data?.type !== 'pi-mermaid-render' || busy) return;
        const { id, source, dark } = event.data;
        if (typeof source !== 'string' || source.length > 20000) return;
        busy = true;
        try {
            // Document-provided configuration is intentionally unsupported.
            if (/^\s*---|%%\s*\{/m.test(source)) throw new Error('configuration');
            mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
                theme: dark ? 'dark' : 'default', maxTextSize: 20000, maxEdges: 200,
                htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'sans-serif' });
            const { svg } = await mermaid.render(`diagram${id}`, source);
            parent.postMessage({ type: 'pi-mermaid-result', id, svg }, '*');
        } catch {
            parent.postMessage({ type: 'pi-mermaid-result', id, error: true }, '*');
        } finally { document.body.replaceChildren(); busy = false; }
    });
    parent.postMessage({ type: 'pi-mermaid-ready' }, '*');
})();
