# ConvertHub AI

Next.js 15 anonymous file-conversion product with Supabase PostgreSQL/Storage, BullMQ/Redis processing, private operations analytics, and an access-key-protected admin dashboard. Visitors do not create accounts or log in.

## Local setup

1. Copy `.env.example` to `.env.local` and fill in the Supabase anon key, Supabase service-role key, Redis URL, and a long random admin dashboard token. The service-role key must remain server-only.
2. Apply every SQL file in `supabase/migrations/` in filename order, including `202610040002_atomic_analytics.sql`. The first migration creates private buckets and the analytics, file, and job tables. The second adds atomic event recording and database-side dashboard aggregation. Storage policies remain private; uploads and downloads use short-lived signed access.
3. Start Redis and configure ClamAV (`clamd`) for production.
4. Run `npm install`, then `npm run dev` for the web app and `npm run worker` in a separate process. Production uses `npm run build` / `npm start` plus a separately deployed worker process.
5. Open `/admin` and enter `ADMIN_DASHBOARD_TOKEN` to view aggregate metrics, queue health, charts, and recent anonymous events.

## Cloud setup without installing conversion tools locally

The repository includes a Railway Dockerfile so the web app and worker can run in the cloud. You do **not** need Docker Desktop, Redis, LibreOffice, FFmpeg, or Poppler installed on your computer. Railway builds the image remotely; its Redis service runs the queue, and the image contains the conversion binaries. This still requires a Railway account and a GitHub repository connected to it, and cloud hosting may incur charges.

1. Push this project to a private GitHub repository. Do not commit `.env.local` or paste secret keys into source files.
2. In Railway, create a project and add a **Redis** database. Railway's generated `REDIS_URL` is used by both app and worker services.
3. Add a service from the Docker image `clamav/clamav:stable` and name the service `clamav`. Keep it private; it must accept TCP connections on port `3310` over Railway private networking.
4. Add the GitHub repository as a service named `web`. Railway detects the root `Dockerfile`. Set its start command to `npm run start` and generate a public domain for this service only.
5. Add the same GitHub repository a second time as a service named `worker`. Use the same Dockerfile and set the start command to `npm run worker`.
6. Add the same variables to both `web` and `worker`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `REDIS_URL=${{Redis.REDIS_URL}}`. Use your existing Supabase project values; keep the service-role key private. Set `WORKER_CONCURRENCY=1` on `worker` to keep memory use conservative.
7. On `worker`, set `CLAMAV_HOST=clamav.railway.internal` and `CLAMAV_PORT=3310`. The image uses `LIBREOFFICE_PATH=soffice`, `FFMPEG_PATH=ffmpeg`, and `PDFTOPPM_PATH=pdftoppm` from the cloud image.
8. Deploy all services. Check the worker logs for `conversion worker ready`; then open the `web` public domain, upload a PDF, choose **PDF to Word → DOCX**, and click **Make it happen**. Download only after the item says **Converted**.

For separate Railway services, configure the start command in each service's Deploy settings rather than sharing one start command across both. Railway's internal service DNS keeps Redis and ClamAV private to the project. If the project has no GitHub remote yet, create a private repository and push the existing project before connecting Railway.

## Environment

See `.env.example`. `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are public values. `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_DASHBOARD_TOKEN`, `REDIS_URL`, and `TURNSTILE_SECRET_KEY` are private server secrets. `TRUST_PROXY_GEO_HEADERS` should only be enabled behind a trusted host that overwrites its geo headers. The app does not collect or persist raw IP addresses, authentication cookies, or session cookies. Visitor/session UUIDs are kept in browser local/session storage, with an in-memory fallback if browser storage is unavailable.

Cloudflare Turnstile is optional and activates when both site and secret keys are configured. Rate limits apply to analytics, uploads, conversions, retries, and dashboard requests. Redis-backed rate limits are shared across app instances; without Redis, the development fallback is process-local. Production processing fails closed when ClamAV is not configured.

## Current processors

- Sharp: image format conversion, resize, crop, compression, blur, and sharpen.
- pdf-lib: PDF compression, merge, split, rotate, unlock, watermark, and page numbering.
- Poppler `pdftoppm`: PDF first-page raster export to JPG/PNG.
- LibreOffice `soffice`: Word/PDF conversions.
- FFmpeg: video/audio conversions, trim, compression, and audio extraction.

Install external binaries in the worker image and keep them on `PATH`, or set `PDFTOPPM_PATH`, `LIBREOFFICE_PATH`, and `FFMPEG_PATH`. Each invocation uses `execFile` with argument arrays and generated temporary paths. OCR, AI background removal/upscaling, transcription, PDF image extraction, platform downloaders, and deeper video editing need dedicated model/vendor adapters before the associated product tools can be offered as completed capabilities. Unsupported requests fail with a clear worker error rather than returning a fake output.

Uploads use direct private Supabase Storage. Files larger than 6 MB use signed TUS resumable uploads in 6 MB chunks; smaller files use signed standard uploads. The current worker loads source files into memory for processing, so the configured 100 MB maximum and worker concurrency must be sized to the deployment’s RAM. Original and converted files expire after 24 hours; expired objects and local worker temporary directories are cleaned periodically. Analytics and session rows are retained for 90 days.

## API overview

- `POST /api/analytics` — validated, anonymous event collection.
- `POST /api/uploads/sign` and `/api/uploads/complete` — issue a signed upload token and confirm the object.
- `POST /api/conversions` — ownership-check source objects and enqueue conversion work.
- `GET /api/conversions/:jobId?visitorId=…&sessionId=…` — poll status; completed jobs receive an expiring signed download URL.
- `POST /api/conversions/:jobId/cancel` — cancel jobs that have not started.
- `POST /api/conversions/:jobId/retry` — enqueue a new attempt for a failed/cancelled job if the original still exists.
- `GET /api/admin/overview` — aggregated admin dashboard data; requires `Authorization: Bearer <ADMIN_DASHBOARD_TOKEN>`.

The Supabase migration has not been applied to the hosted project by this repository. Runtime APIs require the project keys and Redis/worker infrastructure to be configured before they can process real files.
