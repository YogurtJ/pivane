/* Only fixed, local feature assets can be requested through this loader. */
(() => {
    const groups = Object.freeze({
        settings: {
            styles: ['workspace-network.css', 'pi-usage.css', 'pi-profile-knowledge.css', 'pi-profile-learning.css', 'pi-auxiliary-models.css', 'pi-mcp-settings.css'],
            scripts: ['workspace-network.js', 'pi-usage.js', 'pi-native-settings.js', 'pi-system-prompts.js', 'pi-updates.js', 'pi-auxiliary-models.js', 'pi-title-settings.js', 'pi-mcp-settings.js', 'pi-profile-knowledge.js', 'pi-profile-learning.js', 'pi-identity-templates.js', 'pi-agent-profiles.js', 'settings.js'],
            start: () => {
                window.WorkspaceNetwork.start(); window.PiSettings.start();
                if (pendingReveal) {
                    const { method, args } = pendingReveal; pendingReveal = null;
                    window.PiAgentProfilesUI[method](...args);
                }
            }
        },
        cron: { styles: ['pi-cron.css'], scripts: ['pi-cron.js'], start: () => window.PiCron.create({ ...cronOptions, activate: false }) },
        media: { styles: [], scripts: ['media-lab.js'], start: () => window.PiMediaLabPage.start() },
        artifacts: { styles: ['pi-artifacts.css'], scripts: ['pi-artifacts-ui.js', 'pi-artifacts-preview.js', 'pi-artifacts-manage.js', 'pi-artifacts.js'], start: () => window.PiArtifactsPage.start({ activate: false }) },
        connections: { styles: ['media-connections.css', 'pi-transcription-settings.css'], scripts: ['pi-transcription-settings.js', 'media-connections.js'], start: () => window.PiMediaConnectionsPage.start() }
    });
    const assets = new Map(), loading = new Map(), ready = new Set();
    let cronOptions, pendingSettings, pendingReveal, activeSettingsIntent;
    function asset(url, style) {
        if (assets.has(url)) return assets.get(url);
        const promise = new Promise((resolve, reject) => {
            const element = document.createElement(style ? 'link' : 'script');
            if (style) { element.rel = 'stylesheet'; element.href = url; }
            else { element.src = url; element.async = false; }
            element.onload = () => resolve();
            element.onerror = () => { element.remove(); assets.delete(url); reject(new Error(`Unable to load ${url}`)); };
            document.head.append(element);
        });
        assets.set(url, promise);
        return promise;
    }
    function ensure(name) {
        if (!Object.hasOwn(groups, name)) return Promise.reject(new Error('Unknown workspace feature'));
        if (loading.has(name)) return loading.get(name);
        const group = groups[name];
        const promise = (async () => {
            // Install all styles before initialization can reveal a dialog or page.
            await Promise.all(group.styles.map(url => asset(url, true)));
            for (const url of group.scripts) await asset(url, false);
            group.start(); ready.add(name);
        })().catch(error => { loading.delete(name); throw error; });
        loading.set(name, promise);
        return promise;
    }
    function settingsTarget(detail) {
        const tab = detail.tab || 'providers';
        const route = tab === 'profiles' ? 'profiles' : ['extensions', 'installed', 'mcp', 'packages', 'skills'].includes(tab) ? 'extensions' : 'settings';
        return { route, params: route === 'profiles' ? { profileId: detail.profileId, section: detail.section, authoringSession: detail.authoringSession?.id, authoringCwd: detail.authoringSession?.cwd }
            : { tab, ...(detail.section ? { section: detail.section } : {}) } };
    }
    window.PiFeatures = Object.freeze({ ensure, ready: name => ready.has(name),
        routeGroup: tab => ['settings', 'profiles', 'extensions'].includes(tab) ? 'settings' : ['cron', 'media', 'artifacts'].includes(tab) ? tab : null,
        configureCron(options) { cronOptions = options; },
        routeChanged(revision) {
            if (pendingSettings?.revision === null) pendingSettings.revision = revision;
            else if (pendingSettings?.revision !== revision) pendingSettings = null;
            if (activeSettingsIntent?.revision !== revision) activeSettingsIntent = null;
        },
        applySettingsIntent(revision) {
            if (pendingSettings?.revision !== revision) return;
            activeSettingsIntent = pendingSettings; pendingSettings = null;
            window.PiSettings.focus(activeSettingsIntent.detail);
        },
        settingsOpened(revision) {
            const intent = activeSettingsIntent;
            if (!intent || intent.revision !== revision) return;
            requestAnimationFrame(() => {
                if (activeSettingsIntent !== intent || window.PiWorkspaceRoute.revision() !== revision) return;
                activeSettingsIntent = null;
                if (intent.detail.focusTarget !== 'message-view') return;
                const target = document.getElementById('settings-message-view');
                if (!target?.getClientRects().length || document.getElementById('workspace-settings-dialog').classList.contains('hidden')) return;
                target.scrollIntoView({ block: 'center' });
                document.querySelector('#pi-transcript-modes [aria-pressed="true"]')?.focus({ preventScroll: true });
            });
        }
    });
    window.addEventListener('workspace:open-settings', event => {
        pendingSettings = { detail: event.detail || {}, revision: null };
        const target = settingsTarget(pendingSettings.detail);
        window.PiWorkspaceRoute.navigate(target.route, target.params);
    });
    // Keep these public entry points available to chat cards and speech controls.
    window.PiMediaConnections = { open(options) {
        const route = location.hash, revision = window.PiWorkspaceRoute.revision();
        const current = () => location.hash === route && window.PiWorkspaceRoute.revision() === revision;
        void ensure('connections').then(() => { if (current()) window.PiMediaConnections.open(options); })
            .catch(error => { if (current()) window.PiFeatureFeedback.show(error, () => window.PiMediaConnections.open(options)); });
    } };
    document.addEventListener('DOMContentLoaded', () => {
        const sessionProfile = window.PiProfileSession.create();
        window.PiProfileSessionState = sessionProfile;
        window.PiAgentProfilesUI = { ...sessionProfile, projectChanged: sessionProfile.invalidateLoaded,
            revealKnowledge(...args) { pendingReveal = { method: 'revealKnowledge', args }; },
            revealProjectMemory(...args) { pendingReveal = { method: 'revealProjectMemory', args }; }
        };
        window.addEventListener('workspace:agent-profiles-status', event => window.PiAgentProfilesUI.setEnabled(event.detail?.enabled === true));
        document.getElementById('workspace-settings-toggle').addEventListener('click', () => window.PiWorkspaceRoute.navigate('settings', { tab: window.PiSettings?.activeTab?.() || 'providers' }));
        // Buttons exist in the shell before their dialog's code is requested.
        document.addEventListener('click', event => {
            if (ready.has('connections')) return;
            const button = event.target.closest('[data-media-settings-kind]');
            if (button) window.PiMediaConnections.open({ kind: button.dataset.mediaSettingsKind, origin: 'settings' });
        });
    }, { once: true });
})();
