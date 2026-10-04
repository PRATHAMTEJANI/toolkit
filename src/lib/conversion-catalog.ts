const outputsByTool: Record<string, readonly string[]> = {
  "PDF to Word": ["docx"], "Word to PDF": ["pdf"], "PDF to JPG": ["jpg", "jpeg"], "PDF to PNG": ["png"],
  "Compress PDF": ["pdf"], "Merge PDF": ["pdf"], "Split PDF": ["pdf"], "Rotate PDF": ["pdf"], "Unlock PDF": ["pdf"], "Number PDF pages": ["pdf"], "Watermark PDF": ["pdf"],
  "Image converter": ["jpg", "jpeg", "png", "webp", "tif", "tiff"], "Resize image": ["jpg", "jpeg", "png", "webp", "tif", "tiff"], "Compress image": ["jpg", "jpeg", "png", "webp", "tif", "tiff"], "Crop image": ["jpg", "jpeg", "png", "webp", "tif", "tiff"], "Blur image": ["jpg", "jpeg", "png", "webp", "tif", "tiff"], "Sharpen image": ["jpg", "jpeg", "png", "webp", "tif", "tiff"],
  "Video to MP4": ["mp4"], "Convert video": ["mp4", "avi", "mkv", "mov", "webm", "gif"], "Compress video": ["mp4", "avi", "mkv", "mov", "webm"], "Trim video": ["mp4", "avi", "mkv", "mov", "webm"],
  "Audio converter": ["mp3", "wav", "aac", "ogg"], "Convert audio": ["mp3", "wav", "aac", "ogg"], "Trim audio": ["mp3", "wav", "aac", "ogg"], "Extract audio": ["mp3", "wav", "aac", "ogg"],
};

export function isSupportedConversion(tool: string, targetFormat: string) {
  return outputsByTool[tool]?.includes(targetFormat.toLowerCase()) ?? false;
}

export function supportedOutputFormats(tool: string) {
  return outputsByTool[tool] ?? [];
}
