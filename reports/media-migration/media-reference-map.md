# Media reference map — V2 Enterprise

Derived from the Mongoose models in `K:\Projects\V2-enterprise\backend\src\models\*.ts` (branch `dev`, HEAD `401444d`)
and the route modules under `backend/src/modules/`. **Collection names below are what Mongoose's pluralisation rules
produce; they have NOT been confirmed against a live database** (none was reachable). Confirm each with
`media-migrate discover --config … ` (samples real documents and flags media-looking fields that are missing from the map)
and `db.getCollectionNames()` on staging before the first non-dry run.

## Fields in the migration field map (`examples/v2-enterprise.config.json`)

| Collection (Mongoose model) | Field pattern | Model source | Served by | Notes |
|---|---|---|---|---|
| `products` (`Product`) | `photo` | `Product.ts:photo` (required) | `GET /api/v1/products`, `/:id` | primary card + PDP image |
| | `photos[]` | `Product.ts:photos` | same | gallery; the same file is frequently used in `photo`, `photos[0]` and `hoverImage` → **one asset, several references** |
| | `hoverImage` | `Product.ts:hoverImage` | same | lazily loaded on first hover |
| | *(not mapped)* `videoUrls[]` | `Product.ts:videoUrls` | same | YouTube links only; not media objects |
| `categories` (`Category`) | `image` | `Category.ts:image` | `GET /api/v1/categories` | one known ImageKit URL: external, never rewritten |
| `sliders` (`Slider`) | `image`, `laptopUrl`, `tabletUrl`, `mobileUrl` | `Slider.ts` | `GET /api/v1/sliders/promotional` | `mediaType` may be `video` → MP4 values are **skipped** by policy |
| `heroslides` (`HeroSlide`) | `url`, `poster`, `laptopUrl`, `tabletUrl`, `mobileUrl` | `HeroSlide.ts` | `GET /api/v1/sliders/hero` | `url` is usually an MP4 (skipped); `poster` is an image |
| `contents` (`Content`) | `image` | `Content.ts:image` | `GET /api/v1/content/:type` | lookbook, social posts, features, logo |
| `journalposts` (`JournalPost`) | `image` | `JournalPost.ts:image` | (home journal section) | required field |
| `sitesettings` (`SiteSettings`) | `logoImage` | `SiteSettings.ts` | `GET /api/v1/settings` | currently `https://v2enterprise.in/v2_logo.webp` (own origin, not a legacy host → untouched) |
| | `aboutContent.heroImage`, `.visionImage`, `.footerImage` | | same | defaults are Pexels URLs → external, never rewritten |
| | `homeSections.categories[].image` | | same | |
| | `homeSections.promotionalSliders[].image` | | same | `type: 'video'` entries hold MP4s (skipped) |
| | `homeSections.promotionalBanner.image` | | same | |
| | `homeSections.newStandard.image` | | same | |

## Deliberately NOT in the field map (decisions to confirm)

| Location | Why excluded | What to do |
|---|---|---|
| `media` (`Media`) `.url`, `.fileId` | `fileId` is the unique R2 key used to identify/delete a library entry; `.url` is the library's identity of the *original*. Rewriting would desynchronise the library from the bucket. | Keep. Admin thumbnails are optimised instead via the verified mapping (`MEDIA_MAPPING_FILE`, V2 `backend/src/utils/mediaMapping.ts`). |
| `orders` (`Order`) `.items[].productPhoto` | Historical order snapshot (a business record). Display-only, but changing past orders needs an explicit decision. | Not migrated. Legacy URLs keep working because originals are never removed. If desired, add `{ "name": "orders", "fields": ["items[].productPhoto"] }` after review. |
| `users`, `reviews`, `coupons`, `attributes`, `filtersuggestions`, `contactmessages` | no media fields in the models | — |
| `Product.customAttributes` (Map) | free-form strings; the test fixture proves a legacy URL stored there is never touched | `discover` will surface it if real data contains URLs there |

## Hosts

| Host | Treatment |
|---|---|
| `cdn.v2enterprise.in` | **legacy host** (Cloudflare custom domain on the R2 bucket); also the destination base URL |
| `pub-<hash>.r2.dev` | **legacy host** — confirmed from the production database on 2026-10-11: `pub-8848428a9a9e4b2bb5d68abcd08009a6.r2.dev` (432 references in the main media fields). Do not use `*.r2.dev` (matches other people's buckets; validation warns) |
| `ik.imagekit.io`, `images.pexels.com`, `images.unsplash.com`, `v2-fashion.s3.amazonaws.com` | external → counted in the inventory, **never** rewritten (also listed in `safety.neverRewriteHosts`) |
| `v2enterprise.in` | own app origin (`/v2_logo.webp`, `/videos/*`, `/sliders/*`) → not a bucket → untouched |
| `youtu.be` | external |

## Verified facts vs. assumptions

* Verified from code: the model fields above, the single choke point `getOptimizedImageUrl()` in the frontend, the upload
  path writing absolute `${R2_PUBLIC_URL}/${key}` URLs, `listR2Objects()` using the full original as `thumbnailUrl`.
* Quoted from `reports/media-and-bundle-investigation.md` (not re-measured here): URL counts (1,107 CDN + 152 r2.dev
  product URLs), all product files are JPEG, sampled originals 1200–3024 px, median 340 KB, three byte-identical files.
* **Assumption, to verify on staging:** exact collection names, that `pub-…r2.dev` serves the same bucket keys as the CDN
  host, that no other field holds media URLs (use `discover`).
