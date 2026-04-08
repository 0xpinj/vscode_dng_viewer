# DNG Viewer for VS Code

View DNG (Digital Negative) raw camera files directly in VS Code — just like the built-in PNG/JPG viewer.

## Features

- **Inline DNG preview** — open any `.dng` file and see it rendered in a tab
- **Full raw decode** — decodes actual sensor data via LibRaw (WASM), no embedded preview required
- **Fast path** — extracts embedded JPEG thumbnail when available for instant display
- **Zoom & pan** — mouse wheel zoom, click-drag pan, fit-to-window, and actual-size buttons
- **EXIF metadata** — toggle a sidebar showing camera, lens, exposure, and other metadata
- **Theme-aware** — adapts to dark, light, and high-contrast VS Code themes
- **Cross-platform** — pure WASM/JS, works on Linux, macOS, and Windows with no native dependencies

## Usage

1. Install the extension
2. Open any `.dng` file in VS Code
3. The image renders automatically in a custom editor tab

### Controls

| Action | Input |
|--------|-------|
| Zoom in/out | Mouse wheel, `+`/`-` keys, toolbar buttons |
| Pan | Click and drag (when zoomed in) |
| Fit to window | `Fit` button or `0` key |
| Actual size | `100%` button or `1` key |
| Toggle EXIF | `EXIF` button or `I` key |
| Toggle fit/100% | Double-click |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `dngViewer.halfSize` | `true` | Decode at half resolution for faster loading |
| `dngViewer.useCameraWb` | `true` | Use camera's recorded white balance |

## How It Works

1. Tries to extract an embedded JPEG preview via [exifr](https://github.com/nicxmoore/exifr) (instant, ~2ms)
2. If no preview exists, decodes raw sensor data via [libraw-wasm](https://github.com/nicxmoore/libraw-wasm) (WebAssembly port of LibRaw)
3. Encodes decoded RGB pixels to JPEG via [jpeg-js](https://github.com/nicxmoore/jpeg-js) (pure JS)
4. Displays in a VS Code webview with zoom/pan controls

## Requirements

- VS Code 1.74.0 or later

## License

MIT
