const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pivane-native-theme-'));
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
process.env.PI_OFFLINE = '1';
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('native theme discovery applies strict schema validation at startup and reload without modifying source files', async () => {
    const { initializeNativeThemeValidation } = await import('../server/pi-theme-validation.mjs');
    const first = initializeNativeThemeValidation();
    assert.equal(initializeNativeThemeValidation(), first, 'concurrent initialization is idempotent');
    await first;
    await initializeNativeThemeValidation();
    const { DefaultResourceLoader, SettingsManager, getPackageDir } = await import('@earendil-works/pi-coding-agent');
    const source = JSON.parse(fs.readFileSync(path.join(getPackageDir(), 'dist/modes/interactive/theme/dark.json'), 'utf8'));
    const validPath = path.join(root, 'valid.json'), invalidPath = path.join(root, 'invalid.json');
    const valid = { ...source, $schema: 'https://pi.dev/schemas/theme.schema.json', name: 'Fixture valid' };
    const invalid = { ...valid, name: 'Fixture invalid', unsupportedMetadata: { keep: true } };
    fs.writeFileSync(validPath, JSON.stringify(valid)); fs.writeFileSync(invalidPath, JSON.stringify(invalid));
    const initialInvalid = fs.readFileSync(invalidPath);
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true,
        additionalThemePaths: [validPath, invalidPath] });
    await loader.reload();
    let themes = loader.getThemes();
    assert.ok(themes.themes.some(theme => theme.name === valid.name));
    assert.ok(!themes.themes.some(theme => theme.name === invalid.name));
    assert.ok(themes.diagnostics.some(diagnostic => diagnostic.path === invalidPath && diagnostic.type === 'warning' && /Invalid theme/.test(diagnostic.message)));
    assert.deepEqual(fs.readFileSync(invalidPath), initialInvalid, 'validation never repairs unsupported theme fields');
    const repaired = { ...valid, name: invalid.name };
    fs.writeFileSync(invalidPath, JSON.stringify(repaired));
    await loader.reload();
    themes = loader.getThemes();
    assert.ok(themes.themes.some(theme => theme.name === invalid.name));
    assert.ok(!themes.diagnostics.some(diagnostic => diagnostic.path === invalidPath));
    const unknownColor = { ...repaired, colors: { ...repaired.colors, unsupportedColor: '#ffffff' } };
    fs.writeFileSync(invalidPath, JSON.stringify(unknownColor));
    const unknownColorBytes = fs.readFileSync(invalidPath);
    await loader.reload();
    assert.ok(loader.getThemes().diagnostics.some(diagnostic => diagnostic.path === invalidPath));
    assert.deepEqual(fs.readFileSync(invalidPath), unknownColorBytes);
    const brokenColor = { ...repaired, colors: { ...repaired.colors, accent: 'undefined-variable' } };
    fs.writeFileSync(invalidPath, JSON.stringify(brokenColor));
    const brokenBytes = fs.readFileSync(invalidPath);
    await loader.reload();
    assert.ok(loader.getThemes().diagnostics.some(diagnostic => diagnostic.path === invalidPath));
    assert.deepEqual(fs.readFileSync(invalidPath), brokenBytes);
});

test('native theme validation preserves user/project trust, settings and authored bytes', async () => {
    const { initializeNativeThemeValidation } = await import('../server/pi-theme-validation.mjs');
    await initializeNativeThemeValidation();
    const { DefaultResourceLoader, SettingsManager, getPackageDir } = await import('@earendil-works/pi-coding-agent');
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const userDir = path.join(agentDir, 'themes'), projectDir = path.join(root, '.pi/themes');
    fs.mkdirSync(userDir, { recursive: true }); fs.mkdirSync(projectDir, { recursive: true });
    const source = JSON.parse(fs.readFileSync(path.join(getPackageDir(), 'dist/modes/interactive/theme/dark.json'), 'utf8'));
    const userFile = path.join(userDir, 'user.json'), projectFile = path.join(projectDir, 'project.json'), invalidFile = path.join(projectDir, 'invalid.json');
    fs.writeFileSync(userFile, JSON.stringify({ ...source, name: 'User trust fixture' }));
    fs.writeFileSync(projectFile, JSON.stringify({ ...source, name: 'Project trust fixture' }));
    fs.writeFileSync(invalidFile, JSON.stringify({ ...source, name: 'Invalid project trust fixture', metadata: { obsolete: true } }));
    const globalSettings = path.join(agentDir, 'settings.json'), projectSettings = path.join(root, '.pi/settings.json');
    fs.writeFileSync(globalSettings, JSON.stringify({ $schema: 'https://pi.dev/schemas/settings.schema.json', futureField: { keep: true } }));
    fs.writeFileSync(projectSettings, JSON.stringify({ $schema: 'https://pi.dev/schemas/settings.schema.json', futureProjectField: { keep: true } }));
    const authored = [userFile, projectFile, invalidFile, globalSettings, projectSettings].map(file => [file, fs.readFileSync(file)]);
    for (const projectTrusted of [false, true, false]) {
        const loader = new DefaultResourceLoader({ cwd: root, agentDir,
            settingsManager: SettingsManager.create(root, agentDir, { projectTrusted }),
            noExtensions: true, noSkills: true, noPromptTemplates: true });
        await loader.reload();
        const themes = loader.getThemes();
        assert.ok(themes.themes.some(theme => theme.name === 'User trust fixture'));
        assert.equal(themes.themes.some(theme => theme.name === 'Project trust fixture'), projectTrusted);
        assert.equal(themes.diagnostics.some(diagnostic => diagnostic.path === invalidFile), projectTrusted);
        assert.ok(!themes.themes.some(theme => theme.name === 'Invalid project trust fixture'));
        for (const [file, bytes] of authored) assert.deepEqual(fs.readFileSync(file), bytes);
    }
});
