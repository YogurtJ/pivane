/* Shared, keyboard-accessible confirmations for the profile editors. */
(() => {
    'use strict';
    let pending = null;
    function confirm({ title, message, accept, cancelLabel }) {
        if (pending) return Promise.resolve(false);
        const t = text => globalThis.PiI18n?.t(text) || text;
        const focus = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = 'pi-profile-confirm';
        dialog.setAttribute('aria-labelledby', 'pi-profile-confirm-title');
        dialog.setAttribute('aria-describedby', 'pi-profile-confirm-message');
        const heading = document.createElement('h2'); heading.id = 'pi-profile-confirm-title'; heading.textContent = title;
        const body = document.createElement('p'); body.id = 'pi-profile-confirm-message'; body.textContent = message;
        const actions = document.createElement('div'); actions.className = 'pi-profile-confirm-actions';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'settings-secondary-button'; cancel.textContent = cancelLabel || t('继续编辑');
        const proceed = document.createElement('button'); proceed.type = 'button'; proceed.className = 'settings-primary-button pi-profile-confirm-discard'; proceed.textContent = accept;
        actions.append(cancel, proceed); dialog.append(heading, body, actions);
        return new Promise(resolve => {
            const finish = value => {
                pending = null; dialog.close(); dialog.remove();
                if (focus?.isConnected) focus.focus({ preventScroll: true });
                resolve(value);
            };
            pending = () => finish(false);
            cancel.onclick = () => finish(false); proceed.onclick = () => finish(true);
            dialog.oncancel = event => { event.preventDefault(); finish(false); };
            document.body.append(dialog); dialog.showModal(); cancel.focus();
        });
    }
    globalThis.PiProfileDialog = Object.freeze({ confirm, cancel: () => pending?.() });
})();
