// The message display switch lives in Settings → 使用偏好 on every screen size.
async function selectMessageView(page, mode) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'models' } })));
    const button = page.locator(`#pi-transcript-modes [data-transcript-mode="${mode}"]`);
    await button.waitFor({ state: 'visible' });
    await button.click();
    await page.locator('#workspace-settings-close').click();
    await page.locator('#workspace-settings-dialog').waitFor({ state: 'hidden' });
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
