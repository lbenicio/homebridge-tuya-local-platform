# Installation

## Option 1: Homebridge Config UI X

1. Open the Homebridge UI.
2. Go to **Plugins**.
3. Search for `@lbenicio/homebridge-tuya-local-platform`.
4. Click **Install**.
5. Restart Homebridge.

## Option 2: Manual (npm)

```bash
npm install -g @lbenicio/homebridge-tuya-local-platform
```

Restart Homebridge after installation.

## Matter on Homebridge 2

Open the platform's child bridge settings and enable Matter. The plugin publishes supported local devices through the Matter child bridge while retaining the existing HomeKit bridge.

## Verify Installation

Check that the plugin is registered:

```bash
npm list -g @lbenicio/homebridge-tuya-local-platform
```

## Upgrading from `homebridge-tuya` / `TuyaLocalPlatform`

If you previously used the `homebridge-tuya` plugin with `"platform": "TuyaLocalPlatform"`:

1. Uninstall the old plugin.
2. Install this plugin.
3. Update your `config.json` — change `"platform": "TuyaLocalPlatform"` to `"platform": "TuyaLocalPlatform"`.
4. Restart Homebridge.

All device configurations remain compatible.
