async function selectMessageView(page, mode) {
    if (await page.evaluate(() => innerWidth <= 680)) {
        const detailsOpen = await page.locator('#pi-inspector').evaluate(node => node.classList.contains('open'))
            && await page.locator('#pi-details-tab').getAttribute('aria-selected') === 'true';
        if (!detailsOpen) await page.locator('#pi-toggle-inspector').click();
        await page.locator(`#pi-transcript-modes [data-transcript-mode="${mode}"]`).click();
        await page.locator('#pi-close-inspector').click();
    } else {
        await page.locator(`#pi-transcript-modes [data-transcript-mode="${mode}"]`).click();
    }
}

// Media/profiles/extensions moved into the "更多功能" menu on narrow screens.
async function openWorkspaceTab(page, tab) {
    if (await page.evaluate(() => innerWidth <= 680)) {
        await page.locator('#workspace-more-toggle').click();
        await page.locator(`#workspace-more-menu [data-more-tab="${tab}"]`).click();
    } else {
        await page.locator(`[data-tab="${tab}"]`).click();
    }
}
module.exports = { selectMessageView, openWorkspaceTab };
