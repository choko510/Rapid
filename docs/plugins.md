# Rapid Plugin Authoring Guide

This guide explains how to build plugins for Rapid's Plugin Manager.

## 1. Security model (read first)

Rapid plugin execution is intentionally strict:

1. Distribution is from the **active plugin registry** (default: `https://raw.githubusercontent.com/choko510/customRapid-plugin/main/registry.json`)
2. Signed entries (`manifestHash` + `signature` + `keyID`) are signature verified against trusted keys
3. Capabilities are user-approved when a plugin is enabled the first time
4. Revoked plugins are disabled immediately

Unsigned plugins can still load from registries that users explicitly add.

## 2. Manifest

Create a JSON manifest:

```json
{
  "version": 1,
  "id": "example-plugin",
  "name": "Example Plugin",
  "description": "Adds quick actions",
  "pluginVersion": "1.0.0",
  "kinds": ["ui", "operation"],
  "tags": ["qa", "productivity"],
  "capabilities": ["ui.toolbar", "ui.commandPalette"],
  "entrypoint": "https://raw.githubusercontent.com/choko510/customRapid-plugin/main/plugins/example-plugin/index.mjs"
}
```

Notes:

* `id`, `name`, `kinds`, and `entrypoint` are required
* `kinds` values: `data`, `ui`, `operation`
* `tags` is optional and used for catalog filtering UI
* `capabilities` should be minimal and explicit

## 3. Entrypoint module

The entrypoint module must export `enable`:

```js
export function enable(api, manifest) {
  api.registerCommand({
    id: 'open-issues',
    label: 'Open Issues Pane',
    keywords: 'issues qa validation',
    run: () => api.context.systems.ui?.Overmap?.MapPanes?.Issues?.togglePane()
  });

  api.registerToolbarButton({
    id: 'open-issues',
    label: 'Issues',
    title: 'Open Issues Pane',
    run: () => api.context.systems.ui?.Overmap?.MapPanes?.Issues?.togglePane()
  });
}

export function disable(api, manifest) {
  // optional
}

export function dispose(api, manifest) {
  // optional
}
```

## 4. Available host API

* `api.registerCommand({ id, label, keywords?, shortcut?, run })`
* `api.registerOperation(...)` (alias)
* `api.registerToolbarButton({ id, label, title?, run })`
* `api.registerDatasetManifest(manifest)`
* `api.notify(message, kind?)`
* `api.t(stringID, replacements?)`
* `api.context`

## 5. Capabilities and permissions

Treat capabilities as a contract with users:

1. Declare only what is required
2. Use clear plugin names/descriptions so permission prompts are understandable
3. Avoid hidden behavior outside declared capability scope

## 6. Versioning and compatibility

* Use semantic versions in `pluginVersion`
* Keep `id` stable across upgrades
* Ship additive changes first; avoid breaking command IDs and button IDs

## 7. Migration tips

If you previously shipped Assist dataset manifests:

1. Keep dataset logic inside a plugin entrypoint
2. Register data through `api.registerDatasetManifest(...)`
3. Move plugin metadata into plugin manifest fields (`kinds`, `capabilities`, `entrypoint`)

## 8. Troubleshooting

### Plugin install fails with signature error

* Ensure registry entry `manifestHash`, `signature`, and `keyID` are correct
* Ensure signature payload matches `id + "\\n" + manifestURL + "\\n" + manifestHash`

### Plugin enables but nothing appears

* Verify `enable` is exported
* Verify your plugin calls at least one registration API
* Verify permissions were granted during enable

### Plugin disabled on startup

* Check revocation status in the active registry index
* Check whether capabilities changed and require new user consent
