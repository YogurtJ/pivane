(() => {
    const t = (text, ...values) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(text, ...values) : text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? '');
    const statuses = { pending: '待开始', in_progress: '进行中', completed: '已完成' };
    class PiTaskProgress {
        constructor(root) {
            this.root = root;
            root.innerHTML = '<summary><i class="fa-solid fa-list-check" aria-hidden="true"></i><strong></strong><span class="pi-progress-count" role="status" aria-live="polite" aria-atomic="true"></span><span class="pi-progress-current"></span><i class="fa-solid fa-chevron-down pi-progress-chevron" aria-hidden="true"></i></summary><div class="pi-progress-body"><ol></ol><p class="pi-progress-explanation" hidden></p></div>';
            this.reset();
        }
        reset() {
            this.value = null;
            this.root.hidden = true;
            this.root.open = false;
        }
        apply(value) {
            const plan = value?.plan;
            if (!value || value.version !== 1 || !Array.isArray(plan) || !plan.length) { this.reset(); return; }
            if (plan.length > 20 || plan.some(item => !item || typeof item.step !== 'string' || !item.step.trim() || item.step.length > 200
                || !Object.hasOwn(statuses, item.status)) || typeof value.explanation !== 'string' || value.explanation.length > 1000) return;
            if (this.value?.id === value.id) return;
            const completed = plan.filter(item => item.status === 'completed').length;
            const done = completed === plan.length;
            const previousDone = this.value?.plan.every(item => item.status === 'completed');
            if (!this.value || previousDone && !done) this.root.open = !done;
            if (done && !previousDone) this.root.open = false;
            this.value = value;
            this.root.hidden = false;
            this.root.querySelector('summary strong').textContent = t('当前进度');
            this.root.querySelector('.pi-progress-count').textContent = `${completed}/${plan.length}`;
            this.root.querySelector('.pi-progress-count').setAttribute('aria-label', t('已完成 {0}/{1} 步', completed, plan.length));
            const current = plan.find(item => item.status === 'in_progress') || plan.find(item => item.status === 'pending');
            const preview = this.root.querySelector('.pi-progress-current');
            preview.textContent = done ? t('全部完成') : current.step;
            preview.title = preview.textContent;
            const list = this.root.querySelector('ol');
            list.replaceChildren(...plan.map(item => {
                const row = document.createElement('li');
                row.dataset.status = item.status;
                const icon = document.createElement('i');
                icon.className = item.status === 'completed' ? 'fa-regular fa-circle-check' : item.status === 'in_progress' ? 'fa-solid fa-circle-dot' : 'fa-regular fa-circle';
                icon.setAttribute('aria-hidden', 'true');
                const text = document.createElement('span'); text.className = 'pi-progress-step'; text.textContent = item.step;
                const status = document.createElement('span'); status.className = 'pi-progress-status'; status.textContent = t(statuses[item.status]);
                row.append(icon, text, status);
                return row;
            }));
            const explanation = this.root.querySelector('.pi-progress-explanation');
            explanation.textContent = value.explanation;
            explanation.hidden = !value.explanation;
        }
    }
    window.PiTaskProgress = PiTaskProgress;
})();
