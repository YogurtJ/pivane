(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    class PiThreadMenu {
        constructor() {
            this.frames = [];
            this.element = document.createElement('div');
            this.element.className = 'pi-thread-menu hidden';
            this.element.setAttribute('role', 'menu');
            this.element.setAttribute('aria-label', translateUi("项目与线程操作"));
            document.body.appendChild(this.element);
            document.addEventListener('pointerdown', event => {
                if (!this.element.contains(event.target)) this.close(false);
            });
            document.addEventListener('keydown', event => {
                if (this.element.classList.contains('hidden')) return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    if (this.frames.length > 1) this.back();
                    else this.close(true);
                } else if (event.key === 'Tab') this.close(true);
            });
            window.addEventListener('resize', () => this.close(false));
            document.addEventListener('scroll', event => {
                // A focus scroll queued before opening can arrive after the menu appears.
                if (event.target === document && this.viewportScroll?.x === scrollX && this.viewportScroll?.y === scrollY) return;
                const before = this.ancestorScroll?.get(event.target);
                if (before && event.target.scrollLeft === before.x && event.target.scrollTop === before.y) return;
                if (!this.element.contains(event.target)) this.close(false);
            }, true);
            this.element.addEventListener('keydown', event => {
                const buttons = [...this.element.querySelectorAll('button:not(:disabled)')];
                const index = buttons.indexOf(document.activeElement);
                let next;
                if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
                if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
                if (event.key === 'Home') next = 0;
                if (event.key === 'End') next = buttons.length - 1;
                if (event.key === 'ArrowRight' && document.activeElement?.hasAttribute('aria-haspopup')) {
                    event.preventDefault();
                    document.activeElement.click();
                }
                if (event.key === 'ArrowLeft' && this.frames.length > 1) {
                    event.preventDefault();
                    this.back();
                }
                if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
            });
        }

        open(anchor, items, point) {
            this.close(false);
            this.anchor = anchor;
            this.point = point;
            this.frames = [{ items, label: translateUi("项目与线程操作"), focusIndex: 0 }];
            anchor?.setAttribute('aria-expanded', 'true');
            this.element.classList.remove('hidden');
            this.render();
            this.viewportScroll = { x: scrollX, y: scrollY };
            this.ancestorScroll = new Map();
            for (let parent = anchor?.parentElement; parent; parent = parent.parentElement) {
                this.ancestorScroll.set(parent, { x: parent.scrollLeft, y: parent.scrollTop });
            }
        }

        back() {
            this.frames.pop();
            this.render();
        }

        render() {
            const frame = this.frames.at(-1);
            this.element.setAttribute('aria-label', frame.label);
            this.element.replaceChildren();
            const items = this.frames.length > 1
                ? [{ label: translateUi("返回"), icon: 'fa-arrow-left', back: true }, ...frame.items] : frame.items;
            for (const [index, item] of items.entries()) {
                const button = document.createElement('button');
                button.type = 'button';
                button.setAttribute('role', 'menuitem');
                button.disabled = Boolean(item.disabled);
                if (item.danger) button.classList.add('danger');
                if (item.back) button.classList.add('pi-thread-menu-back');
                const icon = document.createElement('i');
                icon.className = `fa-solid ${item.icon}`;
                icon.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.textContent = item.label;
                button.append(icon, label);
                if (item.children) {
                    button.setAttribute('aria-haspopup', 'menu');
                    const arrow = document.createElement('i');
                    arrow.className = 'fa-solid fa-chevron-right pi-thread-menu-next';
                    arrow.setAttribute('aria-hidden', 'true');
                    button.appendChild(arrow);
                }
                button.addEventListener('click', () => {
                    if (item.back) return this.back();
                    if (item.children) {
                        frame.focusIndex = index;
                        this.frames.push({ items: item.children, label: item.label, focusIndex: 1 });
                        this.render();
                    } else { this.close(true); item.run(); }
                });
                this.element.appendChild(button);
            }
            const rect = this.anchor?.getBoundingClientRect();
            const x = this.point?.x ?? rect?.left ?? 8;
            const y = this.point?.y ?? rect?.bottom ?? 8;
            const menu = this.element.getBoundingClientRect();
            this.element.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.width - 8))}px`;
            this.element.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.height - 8))}px`;
            const buttons = this.element.querySelectorAll('button');
            const focused = buttons[frame.focusIndex];
            (focused && !focused.disabled ? focused : this.element.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
        }

        close(restoreFocus = false) {
            if (this.element.classList.contains('hidden')) return;
            this.element.classList.add('hidden');
            this.anchor?.setAttribute('aria-expanded', 'false');
            if (restoreFocus && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
            this.anchor = null;
            this.ancestorScroll = null;
            this.frames = [];
        }
    }
    window.PiThreadMenu = PiThreadMenu;
})();
