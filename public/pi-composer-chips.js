(() => {
    // Collapsed status chips above the composer (subagent runs, task progress).
    // Chips share one row; an opened chip shows its detail as a popover above the
    // row, so it never takes transcript height. Only one popover is open at a time.
    const row = document.getElementById('pi-composer-chips');
    if (!row) return;
    const chips = () => [...row.querySelectorAll(':scope > details.pi-status-chip')];
    const close = (except = null) => { for (const chip of chips()) if (chip !== except && chip.open) chip.open = false; };
    for (const chip of chips()) {
        chip.addEventListener('toggle', () => { if (chip.open) close(chip); });
    }
    // Dialogs opened from a popover (logs, steering, cost) live outside the row.
    document.addEventListener('pointerdown', event => {
        if (!chips().some(chip => chip.open) || row.contains(event.target) || event.target.closest?.('dialog, .pi-toast')) return;
        close();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing || !row.contains(document.activeElement)) return;
        const open = chips().find(chip => chip.open);
        if (!open) return;
        event.preventDefault(); event.stopPropagation();
        open.open = false; open.querySelector('summary')?.focus();
    });
})();
