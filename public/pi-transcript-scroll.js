(() => {
    class PiTranscriptScroll {
        constructor({ viewport, content, track, thumb, latest }) {
            Object.assign(this, { viewport, content, track, thumb, latest });
            this.following = true;
            this.frame = null;
            this.lastTop = viewport.scrollTop;
            this.drag = null;
            viewport.parentElement.classList.add('pi-scroll-enhanced');
            viewport.addEventListener('scroll', () => {
                if (!viewport.clientHeight) return;
                // Ignore our own writes and layout changes that leave the reading position intact.
                const resized = viewport.clientHeight !== this.lastHeight || viewport.scrollHeight !== this.lastScrollHeight;
                if (!resized && Math.abs(viewport.scrollTop - this.lastTop) > 1) {
                    this.following = this.atBottom() && !this.drag;
                }
                this.lastTop = viewport.scrollTop;
                if (resized) this.update();
                this.paint();
            }, { passive: true });
            viewport.addEventListener('wheel', event => {
                if (event.deltaY < 0 && viewport.scrollTop > 0) this.following = false;
            }, { passive: true });
            viewport.addEventListener('touchstart', () => { this.touchY = null; }, { passive: true });
            viewport.addEventListener('touchmove', event => {
                const y = event.touches[0]?.clientY;
                if (this.touchY != null && y > this.touchY && viewport.scrollTop > 0) this.following = false;
                this.touchY = y;
            }, { passive: true });
            viewport.addEventListener('keydown', event => {
                if (event.target !== viewport) return;
                if (viewport.scrollTop > 0 && (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey)) {
                    this.following = false;
                }
            });
            latest.addEventListener('click', () => {
                viewport.focus({ preventScroll: true });
                this.jumpToLatest();
            });
            track.addEventListener('pointerdown', event => this.startDrag(event));
            track.addEventListener('pointermove', event => {
                if (event.pointerId === this.drag?.id) this.moveDrag(event.clientY);
            });
            const endDrag = event => {
                if (event.pointerId !== this.drag?.id) return;
                this.drag = null;
                track.classList.remove('dragging');
                this.following = this.atBottom();
                this.update();
            };
            track.addEventListener('pointerup', endDrag);
            track.addEventListener('pointercancel', endDrag);
            track.addEventListener('lostpointercapture', endDrag);
            track.addEventListener('keydown', event => this.onTrackKey(event));
            this.resizeObserver = new ResizeObserver(() => this.update());
            this.resizeObserver.observe(viewport);
            this.resizeObserver.observe(content);
            this.mutationObserver = new MutationObserver(() => this.update());
            this.mutationObserver.observe(content, { childList: true, subtree: true, characterData: true });
            this.update();
        }

        maximum() {
            return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
        }

        atBottom() {
            return this.maximum() - this.viewport.scrollTop <= 2;
        }

        setTop(top) {
            this.viewport.scrollTop = Math.max(0, Math.min(this.maximum(), top));
            this.lastTop = this.viewport.scrollTop;
        }

        update() {
            if (this.frame !== null) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                if (!this.viewport.clientHeight) return;
                if (this.pendingRestore) {
                    const saved = this.pendingRestore;
                    this.pendingRestore = null;
                    this.restore(saved);
                    return;
                }
                if (this.following && !this.drag) this.setTop(this.maximum());
                this.paint();
            });
        }

        paint() {
            this.lastHeight = this.viewport.clientHeight;
            this.lastScrollHeight = this.viewport.scrollHeight;
            const maximum = this.maximum();
            const height = this.track.clientHeight;
            this.thumbHeight = Math.min(height, Math.max(32, height * this.viewport.clientHeight / Math.max(1, this.viewport.scrollHeight)));
            const position = maximum ? this.viewport.scrollTop / maximum * (height - this.thumbHeight) : 0;
            this.thumb.style.height = `${this.thumbHeight}px`;
            this.thumb.style.transform = `translateY(${position}px)`;
            this.track.classList.toggle('inactive', maximum <= 2);
            this.track.tabIndex = maximum > 2 ? 0 : -1;
            this.track.setAttribute('aria-valuemax', String(Math.round(maximum)));
            this.track.setAttribute('aria-valuenow', String(Math.round(this.viewport.scrollTop)));
            this.latest.hidden = maximum <= 2 || this.atBottom();
            if (this.viewport.clientHeight && !this.following) this.readingAnchor = this.captureAnchor();
        }

        jumpToLatest() {
            this.following = true;
            this.setTop(this.maximum());
            this.paint();
            this.update();
        }

        reset() {
            this.pendingRestore = null;
            this.readingAnchor = null;
            this.drag = null;
            this.track.classList.remove('dragging');
            this.following = true;
            this.setTop(0);
            this.latest.hidden = true;
            this.update();
        }

        startDrag(event) {
            if (event.button !== 0 || this.maximum() <= 2) return;
            event.preventDefault();
            this.paint();
            this.following = false;
            this.track.focus({ preventScroll: true });
            this.drag = {
                id: event.pointerId,
                offset: event.target === this.thumb
                    ? event.clientY - this.thumb.getBoundingClientRect().top
                    : this.thumbHeight / 2
            };
            this.track.setPointerCapture(event.pointerId);
            this.track.classList.add('dragging');
            this.moveDrag(event.clientY);
        }

        moveDrag(y) {
            const travel = this.track.clientHeight - this.thumbHeight;
            if (travel <= 0) return;
            const position = y - this.track.getBoundingClientRect().top - this.drag.offset;
            this.setTop(position / travel * this.maximum());
            this.paint();
        }

        onTrackKey(event) {
            const steps = {
                ArrowUp: -40, ArrowDown: 40,
                PageUp: -this.viewport.clientHeight * 0.9,
                PageDown: this.viewport.clientHeight * 0.9,
                Home: -this.maximum(), End: this.maximum()
            };
            if (!(event.key in steps)) return;
            event.preventDefault();
            this.setTop(this.viewport.scrollTop + steps[event.key]);
            this.following = this.atBottom();
            this.paint();
        }

        visibleAnchor(node) {
            if (!node || node.closest('[hidden]')) return null;
            for (let parent = node.parentElement; parent && parent !== this.content; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS' && !parent.open) return null;
            }
            return node.getClientRects().length ? node : null;
        }

        captureAnchor() {
            const children = [...this.content.children].filter(child => !child.hidden);
            const top = this.viewport.getBoundingClientRect().top;
            // Message blocks are vertically ordered; only inspect the visible anchor on scroll.
            let low = 0;
            let high = children.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (children[middle].getBoundingClientRect().bottom <= top) low = middle + 1;
                else high = middle;
            }
            const article = children[low];
            const blocks = article ? [...article.querySelectorAll('[data-reading-key]')].filter(node => this.visibleAnchor(node)) : [];
            const block = blocks.find(node => node.getBoundingClientRect().bottom > top);
            const anchor = block || article;
            return {
                top: this.viewport.scrollTop,
                index: article ? [...this.content.children].indexOf(article) : -1,
                key: article?.dataset.messageKey,
                readingKey: anchor?.dataset.readingKey,
                processKey: anchor?.dataset.processKey,
                offset: anchor ? anchor.getBoundingClientRect().top - top : 0
            };
        }

        capture() {
            const anchor = this.viewport.clientHeight ? this.captureAnchor() : this.pendingRestore || this.readingAnchor || { top: this.lastTop, index: -1 };
            return {
                ...anchor,
                following: this.following,
                keyedDetails: [...this.content.querySelectorAll('details[data-detail-key]')].map(detail => ({ key: detail.dataset.detailKey, open: detail.open })),
                details: [...this.content.children].map((child, i) => ({
                    key: child.dataset.messageKey,
                    index: i,
                    open: [...child.querySelectorAll('details')].map(detail => detail.open),
                    userTextExpanded: [...child.querySelectorAll('.pi-user-text-toggle')].map(button => button.getAttribute('aria-expanded') === 'true'),
                    ownOpen: child.tagName === 'DETAILS' ? child.open : undefined
                }))
            };
        }

        restore(saved) {
            const children = [...this.content.children];
            const keyed = new Map(children.filter(child => child.dataset.messageKey).map(child => [child.dataset.messageKey, child]));
            const find = item => item.key ? keyed.get(item.key) : children[item.index];
            const detailStates = new Map((saved.keyedDetails || []).map(item => [item.key, item.open]));
            for (const item of saved.details || []) {
                const child = find(item);
                if (!child) continue;
                [...child.querySelectorAll('.pi-user-long-text')].forEach((text, i) => {
                    if (item.userTextExpanded?.[i] !== undefined) text._piSetExpanded?.(item.userTextExpanded[i]);
                });
                if (item.ownOpen !== undefined && !child.dataset.detailKey) child.open = item.ownOpen;
                [...child.querySelectorAll('details')].forEach((detail, i) => {
                    if (!detail.dataset.detailKey && item.open[i] !== undefined) detail.open = item.open[i];
                });
            }
            for (const detail of this.content.querySelectorAll('details[data-detail-key]')) {
                if (detailStates.has(detail.dataset.detailKey)) detail.open = detailStates.get(detail.dataset.detailKey);
            }
            this.beforeRestore?.();
            this.following = saved.following;
            if (!this.viewport.clientHeight) {
                this.pendingRestore = saved;
                return;
            }
            if (this.following) this.setTop(this.maximum());
            else {
                const anchors = new Map([...this.content.querySelectorAll('[data-reading-key]')].map(node => [node.dataset.readingKey, node]));
                const original = anchors.get(saved.readingKey);
                let anchor = this.visibleAnchor(original);
                let offset = saved.offset;
                if (!anchor) {
                    anchor = this.visibleAnchor(anchors.get(saved.processKey || original?.dataset.processKey));
                    if (anchor) offset = 0;
                }
                if (!anchor) anchor = this.visibleAnchor(find(saved));
                const top = anchor
                    ? this.viewport.scrollTop + anchor.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top - offset
                    : saved.top;
                this.setTop(top);
            }
            this.paint();
            this.update();
        }
    }

    window.PiTranscriptScroll = PiTranscriptScroll;
})();
