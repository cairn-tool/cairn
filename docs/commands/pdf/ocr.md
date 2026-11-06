# `pdf ocr`

## Synopsis

```text
cairn pdf ocr <file> [options]
```

Recognises the text on pages that have no text layer, page by page, with word boxes and a confidence
per page. Recognised text is always marked as recognised.

## Arguments

| Argument | Required | Description                      |
| -------- | -------- | -------------------------------- |
| `file`   | Yes      | Path to a PDF, or `-` for stdin. |

## Options

The [common options](common.md#options), plus:

| Option                 | Default                  | Description                                                            |
| ---------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `--pages <ranges>`     | pages with no text layer | Recognise exactly these pages, including ones that carry a text layer. |
| `--lang <code>`        | `eng`                    | Tesseract language code(s): `eng`, or `eng+deu` for several.           |
| `--dpi <n>`            | `300`                    | Resolution pages are rendered at for recognition, 70 to 600.           |
| `--min-confidence <n>` | `60`                     | Report a page whose confidence is below this (`AP473`), 0 to 100.      |
| `--out <file>`         | —                        | Also write the full result — words and boxes included — as JSON.       |
| `--tesseract <path>`   | `tesseract` on `PATH`    | The engine executable.                                                 |
| `--tessdata <dir>`     | the engine's own         | The language data directory, passed to the engine as `--tessdata-dir`. |
| `--strict`             | off                      | Treat low confidence and an empty page as blocking.                    |

`--timeout` defaults to 600000 ms (10 minutes) here rather than 30 seconds: recognition takes a
second or more per page.

## The engine

Recognition is done by the installed [Tesseract](https://github.com/tesseract-ocr/tesseract)
executable, spawned with a fixed argument list and no shell. It reads a PNG of the page on stdin and
writes TSV on stdout; nothing touches the network and no model service is called.

| Platform      | Install                                        | Language data                             |
| ------------- | ---------------------------------------------- | ----------------------------------------- |
| macOS         | `brew install tesseract`                       | `$(brew --prefix)/share/tessdata`         |
| Debian/Ubuntu | `apt install tesseract-ocr tesseract-ocr-eng`  | `/usr/share/tesseract-ocr/5/tessdata`     |
| Fedora        | `dnf install tesseract tesseract-langpack-eng` | `/usr/share/tesseract/tessdata`           |
| Windows       | the UB Mannheim installer                      | `C:\Program Files\Tesseract-OCR\tessdata` |

The language data comes from wherever the engine finds it — its compiled-in directory or
`TESSDATA_PREFIX` — or from `--tessdata`. Another language is one more `.traineddata` file, from a
package (`tesseract-ocr-deu`) or from the `tessdata_fast` repository, dropped into that directory.

A missing engine is `AP470` and a missing language is `AP471`, both exit 1 and both before any page
is rendered: they describe the machine, not the document.

**Why not `tesseract.js`.** The WebAssembly build fetches its language data from a CDN by default,
weighs tens of megabytes before any language data, and bundling `eng.traineddata` in cairn would
make an MIT CLI the distributor of a trained model. The binary is one package-manager command away
on every platform, uses data its own packaging keeps current, and is several times faster.

## Recognised text is always marked

- Every page in the payload carries `"source": "ocr"` and `textLayer`, measured before recognition.
- On stdout every page is introduced by a marker line, pages separated by a form feed:

  ```text
  [recognised text: page 1, tesseract 5.5.4 eng, confidence 95.5]
  Errata
  ...
  ```

- Recognised text is **never merged** into a text layer. A page named with `--pages` that already
  has one is recognised anyway and reported beside it, with `AP474`.

### Why `pdf text` has no `--ocr`

`pdf ocr` stays a separate command, deliberately. `pdf text`'s output is a pure function of the
document — the same file gives the same text on any machine — and its JSON schema says the text came
from the document. An `--ocr` flag would make the same command's output depend on an installed
binary, its version, and its language data, would put recognised and real text in one array where a
consumer can mix them up, and would turn a fast read into minutes of rendering. Composition is
already cheap: `pdf text` reports `AP050` for exactly the pages `pdf ocr` recognises by default, and
a caller wanting both runs both and keeps them apart, which is what the design that motivated this
command requires anyway.

## Coordinates and confidence

Each word carries `box`, in **PDF user space** — points, origin at the bottom left, `/Rotate` not
applied — the same space as [`pdf images`](images.md) and [`pdf render --box`](render.md). A page's
`confidence` is the mean of Tesseract's word confidences **weighted by word length**, so a page of
confidently read prose is not dragged down by specks read as punctuation. It is `null` when nothing
was recognised.

## Deterministic output

The engine runs with `OMP_THREAD_LIMIT=1`, the page image is the deterministic output of
[`pdf render`](render.md), and the page segmentation mode is fixed (`--psm 3`). The same file, the
same Tesseract version, and the same language data give the same words, boxes, and confidences.
`ocr.engine` records the version and languages so a receipt can say what produced the text.

## Output

```console
$ cairn pdf ocr scan.pdf --out scan.ocr.json
[recognised text: page 1, tesseract 5.5.4 eng, confidence 95.5]
Errata

NASA Technical Paper 3137
August 1991
...
```

Under `--format json`, and in the `--out` file:

```json
{
  "command": "ocr",
  "ok": true,
  "source": "scan.pdf",
  "document": { "pageCount": 1, "tagged": false, "encrypted": false },
  "ocr": {
    "engine": {
      "name": "tesseract",
      "version": "5.5.4",
      "languages": ["eng"],
      "dpi": 300,
      "psm": 3
    },
    "minConfidence": 60,
    "pages": [
      {
        "page": 1,
        "source": "ocr",
        "textLayer": "absent",
        "text": "Errata\n\nNASA Technical Paper 3137\nAugust 1991\n…",
        "confidence": 95.5,
        "words": [{ "text": "Errata", "confidence": 96.4, "box": [301.44, 709.2, 337.2, 719.04] }]
      }
    ]
  },
  "output": "/home/me/scan.ocr.json",
  "diagnostics": []
}
```

## Examples

```bash
# The pages that need it
cairn pdf ocr scan.pdf

# A named range, in German and English, kept as JSON beside the source
cairn pdf ocr scan.pdf --pages 3-5 --lang deu+eng --out scan.ocr.json

# Fail CI on any page read with confidence below 80
cairn pdf ocr scan.pdf --min-confidence 80 --strict

# Words with their boxes, for one page
cairn pdf ocr scan.pdf -fj | jq '.ocr.pages[] | select(.page == 3) | .words[] | [.text, .box]'
```

## Exit codes

| Condition                                                                                        | Code | Stream |
| ------------------------------------------------------------------------------------------------ | ---- | ------ |
| Recognised, or every page already has a text layer (`AP475`)                                     | `0`  | stdout |
| Invocation or I/O error, not a PDF, or the engine or language data is missing                    | `1`  | stderr |
| The engine failed on a page (`AP472` error), or low confidence or an empty page under `--strict` | `2`  | stderr |

## Related surfaces

- [Shared PDF command behavior](common.md)
- [`pdf text`](text.md) — the document's own text layer, and `AP050`
- [`pdf render`](render.md) — the renderer recognition reads from
- [Diagnostic codes](../../formats/diagnostic-codes.md#pdf-images-rendering-and-recognition)
