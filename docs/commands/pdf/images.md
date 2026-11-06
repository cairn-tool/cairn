# `pdf images`

## Synopsis

```text
cairn pdf images <file> --out <dir> [options]
```

Writes every raster image the selected pages paint into `--out`, with an index of where each one
sits on its page.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

The [common options](common.md#options), plus:

| Option             | Default    | Description                                                                    |
| ------------------ | ---------- | ------------------------------------------------------------------------------ |
| `--out <dir>`      | (required) | Directory the images and `images.json` are written into. Created when absent.  |
| `--pages <ranges>` | every page | Pages to read, e.g. `1,3,5-8`.                                                 |
| `--min-size <px>`  | `0`        | Index, but do not write, an image whose smaller pixel dimension is below this. |
| `--strict`         | off        | Treat approximations — a colour conversion, a truncated image — as blocking.   |

## What is written

| Image                                                     | Written as                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `DCTDecode`                                               | The JPEG it already is, byte for byte (`.jpg`).                            |
| Grey, 1–8 bits, no mask                                   | A grey PNG at the same bit depth.                                          |
| `Indexed` over grey or RGB, no mask                       | A palette PNG at the same bit depth.                                       |
| A stencil mask (`/ImageMask true`)                        | A 1-bit PNG: painted samples black, the rest white.                        |
| RGB, or anything with a soft, stencil, or colour-key mask | An 8-bit RGB or RGBA PNG; the mask becomes the alpha channel.              |
| CMYK, Lab, Separation, DeviceN                            | An 8-bit RGB PNG converted by formula, reported as `AP401`.                |
| `CCITTFaxDecode`, `JBIG2Decode`                           | Decoded with pdf.js's own codecs, written as a 1-bit PNG.                  |
| `JPXDecode` (JPEG 2000)                                   | Decoded to PNG; if that fails, the original stream as `.jp2` with `AP403`. |

A JPEG's soft mask cannot live inside the JPEG, so it is written beside it as
`img-p<page>-<n>-mask.png` and named in the entry's `mask.file`.

Grey and RGB samples are copied **verbatim**: no ICC profile is applied, so the PNG holds the
document's own sample values. A CMYK JPEG is written as stored, not converted (`AP402`), because the
file is the original; some viewers show an Adobe CMYK JPEG inverted.

File names are generated — `img-p012-03.png` is the third placement on page 12 — and never taken
from the document. An image painted several times is written **once** and listed at every placement
with the same `file`. A rerun into the same directory overwrites its own earlier files.

`images.json` in `--out` is the same payload `--format json` prints, and validates against
`cairn schema pdf-result`.

## Coordinates

Every entry carries `transform`, the image's unit square mapped into **PDF user space**, and `box`,
its bounds there: points, 72 to the inch, origin at the **bottom left** of the page's coordinate
system, `/Rotate` not applied. That is the space [`pdf render --box`](render.md) takes, so a figure
can be cut out with the box `images` reported.

`box` is the placement, not what is visible. A clipping path can show only part of an image —
a screenshot cropped on the page, for instance — and the image file is the whole image either way.

## Reading through the object layer

pdf.js hands images to its renderer already decoded to RGBA, which loses everything this command
reports: the original bytes, the filters, the colour space, and the object number. So `pdf images`
reads the file through cairn's own object layer (`src/pdf/objects/`): a cross-reference reader that
follows incremental updates and cross-reference streams and falls back to a brute-force object scan
(`AP101`) when they are damaged, object-stream inflation, and the standard security handler for a
document encrypted with an empty user password (RC4 and AES-128 and AES-256). A document needing a
real password is refused before any of that runs (`AP010`).

The page's content streams are walked for `Do` and `BI … ID … EI`, entering form XObjects with their
`/Matrix` and `/Resources`, so nested images are reported where they land (`forms` names the chain).
Annotation appearances, Type 3 glyph procedures, and tiling patterns are not read: they are not the
page's own content.

A Separation or DeviceN tint transform that is a PostScript calculator function is **interpreted**
by a fixed operator table on a bounded stack. Nothing from the document is ever compiled into code.

## Bounds

Every decode is capped at 256 MiB of output, so a decompression bomb is an `AP405` finding rather
than an out-of-memory abort. A run stops after 50,000 placements with `AP405`. The `--timeout`
budget covers the whole run and defaults to 300000 ms here, because a large scan is a hundred
megabytes of pixels to decode and re-encode.

## Output

```console
$ cairn pdf images report.pdf --out ./figures --pages 1
p1 #1      16x8        DeviceRGB                DCTDecode        box 72,600,232,680  img-p001-01.jpg
p1 #2      16x8        DeviceRGB                DCTDecode        box 300,600,380,640  img-p001-01.jpg
p1 #3      8x4         DeviceRGB                FlateDecode      box 72,500,152,540  img-p001-03.png
p1 #6      8x8         mask                     raw              box 320,500,360,540  img-p001-06.png
4 placement(s), 3 file(s) written, 0 skipped -> /home/me/figures
```

One entry under `--format json`:

```json
{
  "page": 1,
  "index": 3,
  "object": "11 0 R",
  "name": "Im2",
  "inline": false,
  "width": 8,
  "height": 4,
  "colorSpace": "DeviceRGB",
  "components": 3,
  "bitsPerComponent": 8,
  "filters": ["FlateDecode"],
  "imageMask": false,
  "mask": { "type": "smask", "object": "10 0 R" },
  "transform": [80, 0, 0, 40, 72, 500],
  "box": [72, 500, 152, 540],
  "file": "img-p001-03.png",
  "format": "png",
  "bytes": 89,
  "sha256": "ad9a7bfb3dca6a7d2c3c63c1f099fa64410d1e32bd2f9ba8c2acefb61c309578"
}
```

An inline image has `"object": null` and no `name`. An image below `--min-size` keeps its entry with
`"skipped": "min-size"` and no `file`, so nothing disappears silently; one that could not be decoded
has `"skipped": "undecodable"` and an `AP400`.

## Examples

```bash
# Every image in the document
cairn pdf images report.pdf --out ./figures

# Page 12 only, ignoring rules, bullets, and logos
cairn pdf images report.pdf --out ./figures --pages 12 --min-size 64

# The JPEGs, with where they sit
cairn pdf images report.pdf --out ./figures -fj | jq '.images[] | select(.format == "jpeg") | {file, page, box}'

# Cut out the area around the first image on page 3, at print resolution
box=$(jq -r '[.images[] | select(.page == 3)][0].box | join(",")' figures/images.json)
cairn pdf render report.pdf --page 3 --box "$box" --dpi 300 --out fig.png
```

## Exit codes

| Condition                                                                          | Code | Stream |
| ---------------------------------------------------------------------------------- | ---- | ------ |
| Images written, or the pages paint none                                            | `0`  | stdout |
| Invocation or I/O error, or the input is not a PDF                                 | `1`  | stderr |
| A page's content or the run's budget failed, or any approximation under `--strict` | `2`  | stderr |

An image that cannot be decoded is a warning (`AP400`) and does not stop the others.

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf render`](render.md) — cut a region out by the box this reports
- [`pdf attachments`](attachments.md) — the other command that writes content out of a document
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-images-rendering-and-recognition)
