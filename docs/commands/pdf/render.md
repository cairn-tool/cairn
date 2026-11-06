# `pdf render`

## Synopsis

```text
cairn pdf render <file> --page <n> --out <file.png> [options]
```

Renders one page, or a region of it, to a PNG.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

The [common options](common.md#options), plus:

| Option                | Default    | Description                                                  |
| --------------------- | ---------- | ------------------------------------------------------------ |
| `--page <n>`          | (required) | The 1-based page.                                            |
| `--out <file>`        | (required) | The PNG to write. The image never goes to stdout.            |
| `--box <x0,y0,x1,y1>` | whole page | The region, in PDF user space. Corner order does not matter. |
| `--dpi <n>`           | `150`      | Resolution, 18 to 1200. At 72 one point is one pixel.        |

## The box is PDF user space

`--box` is in points, 72 to the inch, with the **origin at the bottom left** of the page's coordinate
system and `/Rotate` **not** applied — the coordinates a content stream itself uses. It is the same
space [`pdf images`](images.md) reports a placement's `box` in and [`pdf ocr`](ocr.md) reports word
boxes in, so a box read from either can be passed straight to `--box`.

On a rotated page the box still names the unrotated area, and the PNG comes out the way the page
displays — rotated.

The region is converted to device pixels by pdf.js's own viewport transform and **snapped outward
to whole pixels**, then clipped to the page's visible area (its crop box). `render.box` in the
payload is the region actually drawn, mapped back, so the PNG and the box always describe exactly
the same area. Clipping is reported as `AP452`; a box that misses the page entirely is `AP451` and
nothing is written.

## Deterministic output

The same file and the same arguments give **the same PNG bytes**. Two things make that true:

- The page is drawn with fonts from pdf.js's bundled standard-font data, never the host's installed
  fonts, onto a white background.
- The PNG is encoded by cairn from the canvas's pixels — the four chunks a PNG needs, with fixed
  filter choices and a fixed zlib level, and no timestamp, gamma, or text chunk — rather than by
  the canvas's own encoder.

That holds for a given installation — the same Node version, canvas binary, and pdfjs-dist. Byte
identity across operating systems, CPU architectures, Node major versions, or zlib builds is not
claimed: antialiased edges can differ slightly between builds (measured: the same chart rendered
under Node 22 and Node 26 differed in 0.14% of channel values, all on edges), and deflate output can
differ between zlib versions. `render.sha256` is reported so a
receipt can record what was produced.

## The renderer

Rendering is pdf.js drawing onto [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas), a
Skia binding with **prebuilt binaries** for macOS, Linux (glibc and musl), and Windows on x64 and
arm64. It has no install script and compiles nothing. It is the canvas pdf.js itself names as its
Node dependency, and cairn declares it as an **optional** dependency: about 125 KB of JavaScript plus
one 26–34 MB platform binary. Only `pdf render` and `pdf ocr` load it, on demand, so no other command
pays for it. It is always loaded **through pdfjs-dist's own resolution**, so pdf.js and cairn share one
copy even when npm installs two: two native canvas modules in one process crash it.

When it is missing — installed with `--omit=optional`, or on a platform with no prebuilt binary —
the command exits 1 with `AP450` and says how to install it.

WebAssembly routes were considered and rejected. `canvaskit-wasm` (Skia in WebAssembly, about 7 MB)
offers no complete `CanvasRenderingContext2D` for pdf.js to draw on. PDFium or MuPDF compiled to
WebAssembly would be a second PDF engine — MuPDF's build is AGPL — so `render` and every other
command would parse the same file two different ways. A native binary that is already in most
installs, has no build step, and lets pdf.js stay the only parser was the better trade.

pdf.js runs with its `eval` fast paths disabled, so glyph outlines and PostScript functions are
interpreted rather than compiled: nothing from the document becomes code. Annotation appearances are
drawn, as a viewer shows them; no action is ever run.

## Bounds

A render larger than 100 megapixels is refused before drawing (`AP453`); lower `--dpi` or draw a
smaller box. The `--timeout` budget covers the draw.

## Output

```console
$ cairn pdf render report.pdf --page 9 --box 143.6,160,720,471.8 --out chart.png
page 9 box 143.52,159.84,720,471.84 at 150 dpi -> 1201x650 /home/me/chart.png
```

Under `--format json`:

```json
{
  "command": "render",
  "ok": true,
  "source": "report.pdf",
  "document": { "pageCount": 18, "tagged": false, "encrypted": false },
  "render": {
    "page": 9,
    "dpi": 150,
    "width": 1201,
    "height": 650,
    "box": [143.52, 159.84, 720, 471.84],
    "pageBox": [0, 0, 720, 540],
    "rotation": 0,
    "file": "/home/me/chart.png",
    "bytes": 60854,
    "sha256": "e3730b9c81c322fa9074a939ff4512ef6283cae26c6be3d28a4c9bbcaeb2823f"
  },
  "output": "/home/me/chart.png",
  "diagnostics": []
}
```

## Examples

```bash
# A whole page for a viewer
cairn pdf render report.pdf --page 12 --out p12.png

# A figure, at print resolution
cairn pdf render report.pdf --page 12 --box 72,400,540,700 --dpi 300 --out fig-3.png

# The same figure, cut out by the box pdf images reported
cairn pdf render report.pdf --page 12 --box "$(jq -r '.images[0].box | join(",")' figures/images.json)" --out fig-3.png
```

## Exit codes

| Condition                                                                                       | Code | Stream |
| ----------------------------------------------------------------------------------------------- | ---- | ------ |
| PNG written                                                                                     | `0`  | stdout |
| Invocation or I/O error, not a PDF, a bad page or box, too large, or the renderer not installed | `1`  | stderr |
| The page did not render completely (`AP454`); what was drawn is still written                   | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf images`](images.md) — where the boxes come from
- [`pdf ocr`](ocr.md) — renders pages for recognition
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-images-rendering-and-recognition)
