# Transformation specification

Implemented in `src/processing/imageProcessor.ts` (sharp 0.34 / libvips). Every rule below has a test in
`tests/unit/processing.test.ts` unless noted.

## Input validation (before any pixel is decoded for output)

1. File size ≤ `processing.maxSourceBytes` (checked at plan time via HEAD, again while streaming the download).
2. **Content sniffing** by magic bytes (`src/processing/mime.ts`): JPEG, PNG, WebP, GIF, TIFF, AVIF/HEIF, MP4/WebM, SVG, HTML.
   Extensions and `Content-Type` are advisory only (a PNG named `.jpg` is processed as PNG; HTML or SVG named `.jpg` is **skipped**, not decoded).
3. Format must be in `processing.allowedInputFormats`.
4. `width × pageHeight × pages ≤ processing.maxSourcePixels` (decompression-bomb guard), plus libvips `limitInputPixels`.
5. Strict decode (`failOn: warning`): truncated or damaged JPEGs fail instead of being "repaired" silently.

Outcomes: not a raster image / unsupported format → `SKIPPED`; corrupt, too many pixels, decode failure → `FAILED` (permanent, not retried).

## Output

| Aspect | Rule |
|---|---|
| Widths | `processing.widths` are **maximum** widths. `resize({ width, withoutEnlargement: true })`: a 120 px original stays 120 px in every variant file. The *URL* for each nominal width always exists, so the frontend needs no lookup. |
| Orientation | EXIF orientation is applied (`rotate()`), then the tag is dropped. Test: stored 300×200 + orientation 6 → 200×300 output. |
| Colour | Converted to sRGB (`toColourspace('srgb')`). ICC/EXIF handling by `processing.metadata`: `strip` (default), `keep-icc`, `keep-all`. |
| Transparency | Preserved in WebP/AVIF/PNG. JPEG output flattens onto white. |
| Animation | `animated: skip` (default) → `SKIPPED`; `preserve` → animated WebP. Detected via page count (GIF and WebP fixtures). |
| Format | `webp` default. `avif` is accepted only if the installed build can encode it (validated at config load); `jpeg` available. |
| Quality | `quality` (1–100) and `effort` (0–9) per config; part of the **processing fingerprint**. |
| Determinism | Same input bytes + same settings + same libvips ⇒ byte-identical output (tested). The fingerprint and `processor.version` (`sharp-x+vips-y`) are stored in each variant row and object metadata (`processing-version`). |
| Metadata on objects | `sha256`, `asset-id`, `source-key`, `processing-version`, `run-id`; `Content-Type`; `Cache-Control: public, max-age=31536000, immutable`. |

## Validation of generated output

`MediaProcessor.validate()` re-opens the produced file, forces a **full decode** (`stats()`), and checks format and
`width ≤ nominal width`. After upload, the verify stage re-reads each destination object and checks size, content-type
and SHA-256 (`verification.mode=full`). Lossy quality is assessed by a mean-absolute-difference check against a resized
reference on a smooth fixture (`processing: perceptual similarity`) — byte equality is *not* used as a quality metric.

**Human review** (required before production): `dry-run` writes `review.html` + `contact-sheet.png` under
`<reportDir>/<runId>/` showing each sampled source next to its variants with sizes. `readiness --attest samples` records
the reviewer's approval; production `migrate` is blocked without it.

## Idempotency / reuse

A variant is regenerated only if the journal has no verified record for the same `processingVersion` or the destination
object no longer matches the recorded size/checksum. Destination keys are immutable: if a key exists with different
content the asset becomes `CONFLICT` and the operator must bump `destination.namespaceVersion`; variants are never overwritten.

## Video

**Not optimised in this release.** Video files (MP4/WebM by content or extension) are inventoried, marked
`SKIPPED (video-pipeline-not-enabled)`, and their references are never rewritten. `src/processing/video.ts` only probes for
`ffmpeg`/`ffprobe` availability (`execFile`, argv array, timeout, no shell). The V2 hero/promotional MP4s therefore remain
as they are. A future video stage would need: encoder configuration recorded per output, bounded subprocess execution,
output validation, poster extraction.

## Not done / limits

* AVIF output is supported by the code path but was not benchmarked for quality/latency; default stays WebP.
* Perceptual metrics are limited to a mean-absolute-difference sanity check; a real-photo quality study (SSIM/Butteraugli)
  was not performed.
* `fixtures` are generated programmatically (no third-party image licences involved); real camera photos, CMYK JPEGs and
  exotic ICC profiles were not available for testing.
