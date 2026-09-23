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
module.exports = { selectMessageView };
