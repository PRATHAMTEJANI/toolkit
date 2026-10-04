import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { fileTypeFromBuffer } from "file-type";
import type { Job } from "bullmq";
import { env } from "@/lib/server/env";
import { logger } from "@/lib/server/logger";
import { getSupabase } from "@/lib/server/supabase";

const execFile = promisify(execFileCallback);
export type ConversionPayload = { jobId: string; visitorId: string; sessionId: string; tool: string; sourcePaths: string[]; resultPath: string; targetFormat: string; options: Record<string, unknown> };
const MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", gif: "image/gif", mp4: "video/mp4", avi: "video/x-msvideo", mkv: "video/x-matroska", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

async function scanWithClamAv(buffer: Buffer) {
  if (!env.CLAMAV_HOST) {
    if (process.env.NODE_ENV === "production") throw new Error("Virus scanner is not configured; processing is paused for safety.");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT });
    let response = "";
    let settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); else resolve(); };
    socket.setTimeout(20000, () => finish(new Error("Virus scanner timed out.")));
    socket.on("error", finish);
    socket.on("data", (data) => { response += data.toString("utf8"); if (response.includes("\0") || /(?:FOUND|OK|ERROR)\s*$/.test(response)) { if (response.includes("FOUND")) finish(new Error("Uploaded file failed the virus scan.")); else if (response.includes("OK")) finish(); else finish(new Error("Virus scanner returned an error.")); } });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const chunk = buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length));
        const length = Buffer.alloc(4); length.writeUInt32BE(chunk.length, 0); socket.write(length); socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

function isValidOfficePackage(buffer: Buffer, extension: string) {
  const end = Math.max(0, buffer.length - 65_557);
  let endRecord = -1;
  for (let offset = buffer.length - 22; offset >= end; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break; }
  }
  if (endRecord < 0) return false;
  const disk = buffer.readUInt16LE(endRecord + 4);
  const directoryDisk = buffer.readUInt16LE(endRecord + 6);
  const entriesOnDisk = buffer.readUInt16LE(endRecord + 8);
  const entryCount = buffer.readUInt16LE(endRecord + 10);
  const directorySize = buffer.readUInt32LE(endRecord + 12);
  const directoryOffset = buffer.readUInt32LE(endRecord + 16);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount || entryCount < 2 || entryCount > 10_000 || directoryOffset + directorySize > endRecord) return false;

  const expectedPart: Record<string, string> = { docx: "word/document.xml", xlsx: "xl/workbook.xml", pptx: "ppt/presentation.xml" };
  const expectedType: Record<string, string> = {
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  };
  let hasMainPart = false;
  let contentTypes = "";
  let position = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;
  while (position + 46 <= directoryEnd) {
    if (buffer.readUInt32LE(position) !== 0x02014b50) return false;
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    const nameStart = position + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > directoryEnd || (flags & 1) !== 0) return false;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) return false;
    if (name === expectedPart[extension]) hasMainPart = true;
    if (name === "[Content_Types].xml") {
      if (contentTypes || uncompressedSize > 1_000_000 || compressedSize > 1_000_000 || localOffset + 30 > directoryOffset) return false;
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return false;
      if (buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method) return false;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > directoryOffset || dataStart < localOffset || buffer.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength) !== name) return false;
      const data = buffer.subarray(dataStart, dataEnd);
      try {
        const xml = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 1_000_000 }) : null;
        if (!xml || xml.byteLength !== uncompressedSize) return false;
        contentTypes = xml.toString("utf8");
      } catch { return false; }
    }
    position = next;
  }
  return position === directoryEnd && hasMainPart && contentTypes.includes(expectedType[extension]);
}

async function getSource(bucket: string, objectPath: string) {
  const { data, error } = await getSupabase().storage.from(bucket).download(objectPath);
  if (error || !data) throw new Error("Source file is unavailable.");
  const buffer = Buffer.from(await data.arrayBuffer());
  await scanWithClamAv(buffer);
  const fileType = await fileTypeFromBuffer(buffer.subarray(0, Math.min(buffer.length, 4100)));
  const extension = objectPath.split(".").at(-1)?.toLowerCase();
  if (["docx", "xlsx", "pptx"].includes(extension ?? "")) {
    if (fileType?.ext !== "zip" || !isValidOfficePackage(buffer, extension!)) throw new Error("The Office document package is invalid or does not match its extension.");
  } else if (extension === "svg") {
    const text = buffer.toString("utf8").slice(0, 2_000_000);
    if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text) || /<script|foreignObject|javascript:|(?:href|src)\s*=\s*["']https?:/i.test(text)) throw new Error("SVG file contains unsafe active content or is malformed.");
  } else if (fileType && ![extension, extension === "jpg" ? "jpeg" : ""].includes(fileType.ext)) {
    throw new Error("The file contents do not match the selected file type.");
  } else if (!fileType && !["docx", "xlsx", "pptx", "doc", "xls", "ppt", "svg"].includes(extension ?? "")) {
    throw new Error("File type could not be verified.");
  }
  return buffer;
}

function optionInt(options: Record<string, unknown>, key: string, fallback: number, min: number, max: number) {
  const value = options[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key} option.`);
  return value;
}

async function processImage(input: Buffer, payload: ConversionPayload) {
  const format = payload.targetFormat.toLowerCase() === "jpg" ? "jpeg" : payload.targetFormat.toLowerCase();
  if (!["jpeg", "png", "webp", "tiff"].includes(format)) throw new Error("Image output must be JPG, PNG, WebP, or TIFF.");
  let image = sharp(input, { limitInputPixels: 80_000_000, animated: false });
  if (payload.tool === "Resize image") {
    image = image.resize(optionInt(payload.options, "width", 1600, 1, 6000), optionInt(payload.options, "height", 1600, 1, 6000), { fit: "inside", withoutEnlargement: true });
  }
  if (payload.tool === "Crop image") {
    const metadata = await image.metadata();
    const left = optionInt(payload.options, "left", 0, 0, Math.max(0, (metadata.width ?? 1) - 1));
    const top = optionInt(payload.options, "top", 0, 0, Math.max(0, (metadata.height ?? 1) - 1));
    const width = optionInt(payload.options, "width", metadata.width ?? 1, 1, metadata.width ?? 1);
    const height = optionInt(payload.options, "height", metadata.height ?? 1, 1, metadata.height ?? 1);
    image = sharp(input).extract({ left, top, width: Math.min(width, (metadata.width ?? 1) - left), height: Math.min(height, (metadata.height ?? 1) - top) });
  }
  if (payload.tool === "Blur image") image = image.blur(optionInt(payload.options, "sigma", 5, 1, 100));
  if (payload.tool === "Sharpen image") image = image.sharpen();
  if (format === "jpeg") image = image.jpeg({ quality: optionInt(payload.options, "quality", 82, 20, 100), mozjpeg: true });
  else if (format === "png") image = image.png({ compressionLevel: 9 });
  else if (format === "webp") image = image.webp({ quality: optionInt(payload.options, "quality", 82, 20, 100) });
  else image = image.tiff({ quality: optionInt(payload.options, "quality", 82, 20, 100) });
  return image.toBuffer();
}

async function processPdf(sources: Buffer[], payload: ConversionPayload, signal?: AbortSignal) {
  const tool = payload.tool;
  if (tool === "PDF to Word" || tool === "Word to PDF") return externalDocumentConversion(sources[0], payload, signal);
  if (tool === "PDF to JPG" || tool === "PDF to PNG") return externalPdfRaster(sources[0], payload, signal);
  const first = await PDFDocument.load(sources[0], { ignoreEncryption: tool === "Unlock PDF", updateMetadata: false });
  let output = first;
  if (tool === "Merge PDF") {
    output = await PDFDocument.create();
    for (const source of sources) { const document = await PDFDocument.load(source, { ignoreEncryption: false }); const pages = await output.copyPages(document, document.getPageIndices()); pages.forEach((page) => output.addPage(page)); }
  } else if (tool === "Split PDF") {
    const indexes = payload.options.pageIndexes;
    const chosen = Array.isArray(indexes) ? indexes.filter((page): page is number => typeof page === "number" && Number.isInteger(page) && page >= 0 && page < first.getPageCount()) : [0];
    if (!chosen.length) throw new Error("Select at least one valid PDF page index (starting from 0). ");
    output = await PDFDocument.create();
    const pages = await output.copyPages(first, chosen);
    pages.forEach((page) => output.addPage(page));
  } else if (tool === "Rotate PDF") {
    const angle = optionInt(payload.options, "degrees", 90, 0, 270);
    if (![0, 90, 180, 270].includes(angle)) throw new Error("Rotation must be 0, 90, 180, or 270 degrees.");
    first.getPages().forEach((page) => page.setRotation(degrees(angle)));
  } else if (tool === "Watermark PDF" || tool === "Number PDF pages") {
    const font = await first.embedFont(StandardFonts.Helvetica);
    for (const [index, page] of first.getPages().entries()) {
      const { width, height } = page.getSize();
      const text = tool === "Number PDF pages" ? `${index + 1}` : String(payload.options.text ?? "ConvertHub").slice(0, 80);
      page.drawText(text, { x: tool === "Number PDF pages" ? width - 44 : 35, y: tool === "Number PDF pages" ? 22 : height / 2, size: tool === "Number PDF pages" ? 11 : 38, font, color: rgb(0.55, 0.52, 0.65), opacity: 0.45, rotate: tool === "Number PDF pages" ? degrees(0) : degrees(-28) });
    }
  } else if (!["Compress PDF", "Unlock PDF"].includes(tool)) {
    throw new Error(`The ${tool} processor is not installed. Configure its external engine to enable this operation.`);
  }
  return Buffer.from(await output.save({ useObjectStreams: true, addDefaultPage: false }));
}

async function externalPdfRaster(source: Buffer, payload: ConversionPayload, signal?: AbortSignal) {
  const dir = await mkdtemp(path.join(tmpdir(), "converthub-pdf-"));
  try {
    const input = path.join(dir, "source.pdf"); const prefix = path.join(dir, "page");
    await writeFile(input, source);
    const format = payload.targetFormat.toLowerCase() === "jpg" ? "jpeg" : "png";
    try { await execFile(process.env.PDFTOPPM_PATH ?? "pdftoppm", [`-${format}`, "-f", "1", "-l", "1", "-singlefile", "-scale-to", "2400", input, prefix], { timeout: 120000, windowsHide: true, signal }); }
    catch { throw new Error("PDF to image requires Poppler (pdftoppm) installed and on PATH."); }
    const output = await readFile(`${prefix}.${format === "jpeg" ? "jpg" : "png"}`);
    return output;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function externalDocumentConversion(source: Buffer, payload: ConversionPayload, signal?: AbortSignal) {
  const dir = await mkdtemp(path.join(tmpdir(), "converthub-doc-"));
  try {
    const extension = payload.tool === "Word to PDF" ? "docx" : "pdf";
    const input = path.join(dir, `source.${extension}`); await writeFile(input, source);
    const target = payload.tool === "Word to PDF" ? "pdf" : "docx";
    try { await execFile(process.env.LIBREOFFICE_PATH ?? "soffice", ["--headless", "--convert-to", target, "--outdir", dir, input], { timeout: 180000, windowsHide: true, signal }); }
    catch { throw new Error("Office document conversion requires LibreOffice installed and on PATH."); }
    return await readFile(path.join(dir, `source.${target}`));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function processMedia(source: Buffer, payload: ConversionPayload, signal?: AbortSignal) {
  const dir = await mkdtemp(path.join(tmpdir(), "converthub-media-"));
  try {
    const sourceExtension = payload.sourcePaths[0].split(".").at(-1) ?? "dat";
    const input = path.join(dir, `source.${sourceExtension}`); const output = path.join(dir, `result.${payload.targetFormat}`);
    await writeFile(input, source);
    const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input];
    if (payload.tool === "Trim video" || payload.tool === "Trim audio") {
      const start = optionInt(payload.options, "startSeconds", 0, 0, 86400); const duration = optionInt(payload.options, "durationSeconds", 30, 1, 86400);
      args.push("-ss", String(start), "-t", String(duration));
    }
    if (payload.tool === "Extract audio") args.push("-vn");
    if (payload.tool === "Compress video") args.push("-crf", String(optionInt(payload.options, "quality", 27, 18, 40)), "-preset", "medium");
    if (payload.targetFormat.toLowerCase() === "mp3") args.push("-codec:a", "libmp3lame", "-q:a", "3");
    args.push(output);
    try { await execFile(process.env.FFMPEG_PATH ?? "ffmpeg", args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, signal }); }
    catch { throw new Error("Video and audio conversion requires FFmpeg installed and on PATH."); }
    return await readFile(output);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function recordWorkerAnalytics(payload: ConversionPayload, eventType: "conversion_succeeded" | "conversion_failed", processingTimeMs: number, errorCode?: string) {
  const { error } = await getSupabase().rpc("record_anonymous_analytics", {
    p_event: { sessionId: payload.sessionId, visitorId: payload.visitorId, eventType, toolUsed: payload.tool, format: payload.targetFormat, processingTimeMs, errorCode },
    p_browser: null, p_browser_version: null, p_operating_system: null, p_device_type: null,
    p_screen_resolution: null, p_language: null, p_timezone: null, p_country: null, p_city: null,
    p_referrer: null, p_utm_source: null, p_utm_medium: null, p_utm_campaign: null,
  });
  if (error) throw error;
}

export async function processConversion(job: Job<ConversionPayload>, _token?: string, signal?: AbortSignal) {
  if (job.name === "cleanup") return cleanupExpiredFiles();
  const payload = job.data;
  const start = Date.now();
  const supabase = getSupabase();
  const setProgress = async (progress: number) => {
    if (signal?.aborted) throw new Error("Conversion cancelled.");
    await job.updateProgress(progress);
    const { data, error } = await supabase.from("conversion_jobs").update({ status: "active", progress }).eq("id", payload.jobId).eq("status", "active").select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Conversion cancelled.");
  };
  try {
    const { data: started, error: startError } = await supabase.from("conversion_jobs").update({ status: "active", progress: 5, started_at: new Date().toISOString(), attempts: job.attemptsMade + 1 }).eq("id", payload.jobId).in("status", ["queued", "active"]).select("id").maybeSingle();
    if (startError) throw startError;
    if (!started) throw new Error("Conversion cancelled.");
    const sources: Buffer[] = [];
    for (const [index, sourcePath] of payload.sourcePaths.entries()) {
      sources.push(await getSource("originals", sourcePath));
      await setProgress(10 + Math.floor((index + 1) / payload.sourcePaths.length * 20));
    }
    let result: Buffer;
    const sourceExtension = payload.sourcePaths[0].split(".").at(-1)?.toLowerCase() ?? "";
    const imageExts = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff", "gif", "svg", "heic", "heif"]);
    const pdfTools = new Set(["Compress PDF", "Merge PDF", "Split PDF", "Rotate PDF", "Unlock PDF", "Watermark PDF", "Number PDF pages", "PDF to JPG", "PDF to PNG", "PDF to Word"]);
    if (imageExts.has(sourceExtension)) result = await processImage(sources[0], payload);
    else if (sourceExtension === "pdf" && pdfTools.has(payload.tool)) result = await processPdf(sources, payload, signal);
    else if (["Video to MP4", "Trim video", "Convert video", "Compress video", "Extract audio", "Convert audio", "Trim audio", "Audio converter"].includes(payload.tool)) result = await processMedia(sources[0], payload, signal);
    else if (payload.tool === "Word to PDF") result = await externalDocumentConversion(sources[0], payload, signal);
    else throw new Error(`No processor is available for ${payload.tool} yet. Install and configure the required conversion engine.`);
    if (signal?.aborted) throw new Error("Conversion cancelled.");
    if (result.byteLength > env.MAX_UPLOAD_BYTES) throw new Error("The converted file exceeds the configured processing limit.");
    await setProgress(85);
    const { error: uploadError } = await supabase.storage.from("converted").upload(payload.resultPath, result, { contentType: MIME[payload.targetFormat] ?? "application/octet-stream", upsert: true });
    if (uploadError) throw uploadError;
    const elapsed = Date.now() - start;
    const { error: fileError } = await supabase.from("conversion_files").upsert({ session_id: payload.sessionId, visitor_id: payload.visitorId, object_path: payload.resultPath, file_name: `converted.${payload.targetFormat}`, content_type: MIME[payload.targetFormat] ?? "application/octet-stream", size_bytes: result.byteLength, file_role: "converted", expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }, { onConflict: "object_path" });
    if (fileError) throw fileError;
    await job.updateProgress(100);
    const { data: completed, error: completeError } = await supabase.from("conversion_jobs").update({ status: "completed", progress: 100, processing_time_ms: elapsed, finished_at: new Date().toISOString(), error_code: null, error_message: null }).eq("id", payload.jobId).eq("status", "active").select("id").maybeSingle();
    if (completeError) throw completeError;
    if (!completed) throw new Error("Conversion cancelled.");
    try { await recordWorkerAnalytics(payload, "conversion_succeeded", elapsed); }
    catch (analyticsError) { logger.error({ jobId: payload.jobId, error: analyticsError }, "conversion succeeded but analytics could not be recorded"); }
    return { resultPath: payload.resultPath, bytes: result.byteLength, processingTimeMs: elapsed };
  } catch (cause) {
    const elapsed = Date.now() - start;
    const { data: currentJob, error: currentJobError } = await supabase.from("conversion_jobs").select("status").eq("id", payload.jobId).maybeSingle();
    const cancelled = signal?.aborted || (!currentJobError && currentJob?.status === "cancelled");
    if (cancelled) {
      const { error } = await supabase.from("conversion_jobs").update({ status: "cancelled", progress: 0, processing_time_ms: elapsed, error_code: null, error_message: null, finished_at: new Date().toISOString() }).eq("id", payload.jobId);
      if (error) logger.error({ jobId: payload.jobId, error }, "could not persist conversion cancellation");
      return { cancelled: true, processingTimeMs: elapsed };
    }
    const message = cause instanceof Error ? cause.message.slice(0, 300) : "Conversion failed.";
    const retrying = job.attemptsMade + 1 < (job.opts.attempts ?? 3);
    const { error: failureStateError } = await supabase.from("conversion_jobs").update({ status: retrying ? "queued" : "failed", progress: 0, processing_time_ms: elapsed, error_code: "PROCESSING_FAILED", error_message: message, finished_at: retrying ? null : new Date().toISOString() }).eq("id", payload.jobId);
    if (failureStateError) logger.error({ jobId: payload.jobId, error: failureStateError }, "could not persist conversion failure state");
    if (!retrying) {
      try { await recordWorkerAnalytics(payload, "conversion_failed", elapsed, "PROCESSING_FAILED"); }
      catch (analyticsError) { logger.error({ jobId: payload.jobId, error: analyticsError }, "could not record conversion failure analytics"); }
    }
    logger.error({ jobId: payload.jobId, tool: payload.tool, retrying, error: message }, "conversion processing failed");
    throw cause;
  }
}

async function cleanupExpiredFiles() {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("conversion_files").select("id,object_path,file_role").lt("expires_at", new Date().toISOString()).is("deleted_at", null).limit(1000);
  if (error) throw error;
  const groups = new Map<string, string[]>();
  for (const file of data ?? []) {
    const bucket = file.file_role === "original" ? "originals" : file.file_role === "converted" ? "converted" : "temporary";
    groups.set(bucket, [...(groups.get(bucket) ?? []), file.object_path]);
  }
  for (const [bucket, paths] of groups) {
    const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
    if (removeError) { logger.error({ bucket, count: paths.length, error: removeError }, "storage cleanup failed"); continue; }
    await supabase.from("conversion_files").update({ deleted_at: new Date().toISOString() }).in("id", (data ?? []).filter((file) => paths.includes(file.object_path)).map((file) => file.id));
  }
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  await supabase.from("analytics_events").delete().lt("created_at", new Date(cutoff).toISOString());
  await supabase.from("analytics_sessions").delete().lt("visit_time", new Date(cutoff).toISOString());
  for (const name of await readdir(tmpdir()).catch(() => [])) {
    if (!name.startsWith("converthub-pdf-") && !name.startsWith("converthub-doc-") && !name.startsWith("converthub-media-")) continue;
    const tempPath = path.join(tmpdir(), name);
    const info = await stat(tempPath).catch(() => null);
    if (info && info.mtimeMs < Date.now() - env.TEMP_FILE_TTL_SECONDS * 1000) await rm(tempPath, { recursive: true, force: true });
  }
  return { deleted: data?.length ?? 0 };
}
