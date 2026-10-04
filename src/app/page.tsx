"use client";

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { emitAnalytics, getAnonymousIds } from "@/components/anonymous-analytics";
import { Turnstile } from "@/components/turnstile";
import {
  ArrowDownToLine, ArrowLeftRight, ArrowRight, AudioLines, Check, ChevronDown,
  CircleHelp, Clock3, CloudUpload, Command, FileArchive, FileImage, FileText,
  Film, Flame, Globe, Heart, Image as ImageIcon, Layers, LockKeyhole, Menu, Moon, MoreHorizontal,
  ScanText, Search, ShieldCheck, Sparkles, Sun, Upload, WandSparkles,
  X, Zap,
} from "lucide-react";

type Tool = { name: string; description: string; icon: typeof FileText; color: string; category: string; hot?: boolean; fresh?: boolean };
type UploadFile = { id: string; file: File; progress: number; status: "uploading" | "ready" | "processing" | "done" | "error"; target: string; objectPath?: string; jobId?: string; downloadUrl?: string; error?: string };

const categories = ["All tools", "PDF", "Image", "Video", "Audio", "Document", "AI tools", "Social"];
const tools: Tool[] = [
  { name: "PDF to Word", description: "Make PDFs editable in a click", icon: FileText, color: "violet", category: "PDF", hot: true },
  { name: "Compress PDF", description: "Smaller files, same quality", icon: FileArchive, color: "pink", category: "PDF", hot: true },
  { name: "Merge PDF", description: "Bring everything together", icon: Layers, color: "orange", category: "PDF" },
  { name: "PDF to JPG", description: "Every page, a perfect image", icon: FileImage, color: "blue", category: "PDF" },
  { name: "Background remover", description: "One tap to a clean cutout", icon: WandSparkles, color: "green", category: "AI tools", fresh: true },
  { name: "Image converter", description: "PNG, JPG, WebP & more", icon: ImageIcon, color: "orange", category: "Image", hot: true },
  { name: "Resize image", description: "Pixel-perfect, every time", icon: ArrowLeftRight, color: "blue", category: "Image" },
  { name: "Image upscaler", description: "Give every pixel a little love", icon: Sparkles, color: "violet", category: "AI tools", fresh: true },
  { name: "Video to MP4", description: "Plays nicely, everywhere", icon: Film, color: "pink", category: "Video" },
  { name: "Trim video", description: "Keep the good bits", icon: Film, color: "orange", category: "Video" },
  { name: "Audio converter", description: "MP3, WAV, FLAC and more", icon: AudioLines, color: "green", category: "Audio" },
  { name: "Audio to text", description: "Transcripts, minus the typing", icon: ScanText, color: "blue", category: "AI tools", fresh: true },
  { name: "Word to PDF", description: "Polished and ready to share", icon: FileText, color: "blue", category: "Document" },
  { name: "YouTube thumbnail", description: "Save the cover art in seconds", icon: Film, color: "pink", category: "Social" },
  { name: "OpenGraph preview", description: "See how your link shows up", icon: Globe, color: "violet", category: "Social" },
  { name: "Website metadata", description: "A peek behind any page", icon: Globe, color: "green", category: "Social" },
];

const groups = [
  { title: "PDF, minus the paperwork", tag: "PDF", description: "The everyday tools that make documents a little less work.", icon: FileText, color: "violet", tools: ["PDF to Word", "Compress PDF", "Merge PDF", "PDF to JPG"] },
  { title: "Picture-perfect, every time", tag: "Image", description: "Resize, convert and clean up your images without the fuss.", icon: ImageIcon, color: "orange", tools: ["Image converter", "Resize image", "Image upscaler", "Background remover"] },
  { title: "Make more of your media", tag: "Video", description: "Get your clips and sound files in the right shape for anywhere.", icon: Film, color: "pink", tools: ["Video to MP4", "Trim video", "Audio converter", "Audio to text"] },
];

const stats = [{ value: "2.4m+", label: "happy little conversions" }, { value: "160+", label: "ways to transform" }, { value: "4.9/5", label: "from the people who use it" }];

function prettyBytes(bytes: number) {
  if (!bytes) return "0 B";
  const k = 1024;
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${(bytes / k ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  finally { window.clearTimeout(timeout); }
}

function ToolIcon({ tool, size = 18 }: { tool: Tool; size?: number }) {
  const Icon = tool.icon;
  return <span className={`tool-icon ${tool.color}`}><Icon size={size} strokeWidth={1.8} /></span>;
}

export default function Home() {
  const [dark, setDark] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All tools");
  const [favorites, setFavorites] = useState<string[]>(["PDF to Word"]);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [selectedTool, setSelectedTool] = useState("PDF to Word");
  const [targetFormat, setTargetFormat] = useState("docx");
  const [converting, setConverting] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const uploadCancels = useRef(new Map<string, () => void>());
  const [activeTab, setActiveTab] = useState("Everything");
  const [toast, setToast] = useState("");
  const [faqOpen, setFaqOpen] = useState<number | null>(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toolsSection = useRef<HTMLElement>(null);
  const faqs = [
    ["Is ConvertHub really free?", "Yep! The tools you see are here to use, no account or credit card needed. Some larger tasks have sensible file limits, but your everyday converting is free."],
    ["Are my files private?", "Files are handled securely and automatically cleared after processing. We never sell your files or peek inside. Your work stays yours."],
    ["Do I need to sign up?", "Nope. No account, no password, no inbox full of welcome emails. Just pick a tool and get straight to it."],
    ["What file types can I convert?", "PDFs, images, documents, video and audio. We add new formats regularly, so if there’s something you’d love to see, let us know."],
  ];
  const visibleTools = useMemo(() => {
    return tools.filter((tool) => {
      const matchesSearch = `${tool.name} ${tool.description} ${tool.category}`.toLowerCase().includes(search.toLowerCase());
      const matchesFilter = filter === "All tools" || (filter === "Trending" ? tool.hot : filter === "Favorites" ? favorites.includes(tool.name) : filter === "Recent" ? ["Compress PDF", "Image converter"].includes(tool.name) : tool.category === filter);
      return matchesSearch && matchesFilter;
    });
  }, [search, filter, favorites]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  async function uploadFile(file: File, id = `${Date.now()}-${Math.random()}`) {
    setFiles((existing) => existing.some((entry) => entry.id === id) ? existing.map((entry) => entry.id === id ? { ...entry, progress: 5, status: "uploading", error: undefined } : entry) : [...existing, { id, file, progress: 5, status: "uploading", target: targetFormat }]);
    try {
      const { visitorId, sessionId } = getAnonymousIds();
      const contentType = file.type || ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg" } as Record<string, string>)[file.name.split(".").at(-1)?.toLowerCase() ?? ""] || "application/octet-stream";
      const signedResponse = await fetchWithTimeout("/api/uploads/sign", { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", body: JSON.stringify({ visitorId, sessionId, fileName: file.name, contentType, sizeBytes: file.size }) });
      const signed = await signedResponse.json();
      if (!signedResponse.ok) throw new Error(signed.error ?? "Could not prepare a secure upload.");
      setFiles((existing) => existing.map((entry) => entry.id === id ? { ...entry, progress: 15 } : entry));
      if (file.size > 6 * 1024 * 1024) {
        const { Upload: TusUpload } = await import("tus-js-client");
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        if (!anonKey || !supabaseUrl) throw new Error("Supabase public credentials are missing.");
        const storageHost = new URL(supabaseUrl).hostname.replace(".supabase.co", ".storage.supabase.co");
        await new Promise<void>((resolve, reject) => {
          const upload = new TusUpload(file, {
            endpoint: `https://${storageHost}/storage/v1/upload/resumable`,
            retryDelays: [0, 3000, 5000, 10000, 20000],
            headers: { authorization: `Bearer ${anonKey}`, apikey: anonKey, "x-signature": signed.token, "x-upsert": "false" },
            metadata: { bucketName: signed.bucket, objectName: signed.objectPath, contentType, cacheControl: "3600" },
            chunkSize: 6 * 1024 * 1024,
            uploadDataDuringCreation: true,
            removeFingerprintOnSuccess: true,
            onProgress: (uploaded, total) => setFiles((existing) => existing.map((entry) => entry.id === id ? { ...entry, progress: 15 + Math.floor(uploaded / total * 70) } : entry)),
            onError: (error) => { uploadCancels.current.delete(id); reject(error); },
            onSuccess: () => { uploadCancels.current.delete(id); resolve(); },
          });
          uploadCancels.current.set(id, () => { void upload.abort(true); uploadCancels.current.delete(id); reject(new Error("Upload cancelled.")); });
          void upload.findPreviousUploads().then((previous) => { if (previous[0]) upload.resumeFromPreviousUpload(previous[0]); upload.start(); }).catch(reject);
        });
      } else {
        const { getBrowserSupabase } = await import("@/lib/client/supabase");
        const { error: storageError } = await getBrowserSupabase().storage.from(signed.bucket).uploadToSignedUrl(signed.objectPath, signed.token, file, { contentType, upsert: false });
        if (storageError) throw storageError;
      }
      setFiles((existing) => existing.map((entry) => entry.id === id ? { ...entry, progress: 90, objectPath: signed.objectPath } : entry));
      const confirmResponse = await fetchWithTimeout("/api/uploads/complete", { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", body: JSON.stringify({ visitorId, sessionId, objectPath: signed.objectPath, fileName: file.name, contentType, sizeBytes: file.size }) });
      const confirmation = await confirmResponse.json();
      if (!confirmResponse.ok) throw new Error(confirmation.error ?? "Upload verification failed.");
      setFiles((existing) => existing.map((entry) => entry.id === id ? { ...entry, progress: 100, status: "ready", objectPath: signed.objectPath } : entry));
      emitAnalytics("upload");
    } catch (cause) {
      const message = cause instanceof DOMException && cause.name === "AbortError"
        ? "Upload setup timed out. Check your Supabase connection and try again."
        : cause instanceof Error ? cause.message : "Upload failed. Please try again.";
      setFiles((existing) => existing.map((entry) => entry.id === id ? { ...entry, status: "error", error: message } : entry));
      notify(message);
    }
  }

  function processFiles(incoming: FileList | File[]) {
    for (const file of Array.from(incoming)) void uploadFile(file);
  }

  function removeFile(id: string) {
    uploadCancels.current.get(id)?.();
    setFiles((existing) => existing.filter((file) => file.id !== id));
  }

  async function downloadFile(item: UploadFile) {
    if (item.status === "done" && item.jobId) {
      try {
        const { visitorId, sessionId } = getAnonymousIds();
        const response = await fetch(`/api/conversions/${item.jobId}?visitorId=${encodeURIComponent(visitorId)}&sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", credentials: "omit" });
        const status = await response.json();
        if (!response.ok || !status.downloadUrl) throw new Error(status.error ?? "The secure download link is unavailable.");
        const anchor = document.createElement("a"); anchor.href = status.downloadUrl; anchor.rel = "noopener"; anchor.click();
      } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not prepare a secure download."); return; }
      emitAnalytics("download", { toolUsed: selectedTool, format: targetFormat });
      return;
    }
    const url = URL.createObjectURL(item.file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.file.name;
    anchor.click();
    URL.revokeObjectURL(url);
    emitAnalytics("download", { toolUsed: selectedTool, format: item.file.name.split(".").at(-1)?.toLowerCase() });
    notify("Your file is ready to download.");
  }

  async function startConversion() {
    const sources = files.filter((file) => file.status === "ready" && file.objectPath);
    if (!sources.length) return;
    setConverting(true);
    try {
      const { visitorId, sessionId } = getAnonymousIds();
      const response = await fetch("/api/conversions", { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", body: JSON.stringify({ visitorId, sessionId, tool: selectedTool, sourceObjectPaths: sources.map((file) => file.objectPath), targetFormat, captchaToken: captchaToken ?? undefined }) }).finally(() => { setCaptchaToken(null); setCaptchaResetKey((key) => key + 1); });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start conversion.");
      setFiles((existing) => existing.map((file) => sources.some((source) => source.id === file.id) ? { ...file, status: "processing", progress: 5, jobId: body.jobId, error: undefined } : file));
      let attempts = 0;
      const poll = window.setInterval(async () => {
        attempts += 1;
        try {
          const statusResponse = await fetch(`${body.poll}?visitorId=${encodeURIComponent(visitorId)}&sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", credentials: "omit" });
          const status = await statusResponse.json();
          if (!statusResponse.ok) throw new Error(status.error ?? "Could not read conversion status.");
          if (status.status === "completed") {
            window.clearInterval(poll);
            if (!status.downloadUrl) {
              const message = "A secure download link could not be created. Please try again shortly.";
              setFiles((existing) => existing.map((file) => file.jobId === body.jobId ? { ...file, status: "error", error: message } : file));
              notify(message);
              return;
            }
            setFiles((existing) => existing.map((file) => file.jobId === body.jobId ? { ...file, status: "done", progress: 100, downloadUrl: status.downloadUrl } : file));
            notify("Your converted file is ready.");
          } else if (["failed", "cancelled"].includes(status.status) || attempts >= 240) {
            window.clearInterval(poll);
            const message = status.error_message ?? (attempts >= 240 ? "Conversion is taking longer than expected." : "This conversion could not be completed.");
            setFiles((existing) => existing.map((file) => file.jobId === body.jobId ? { ...file, status: "error", error: message } : file));
            notify(message);
          } else {
            setFiles((existing) => existing.map((file) => file.jobId === body.jobId ? { ...file, progress: status.progress ?? file.progress } : file));
          }
        } catch (cause) {
          window.clearInterval(poll);
          setFiles((existing) => existing.map((file) => file.jobId === body.jobId ? { ...file, status: "error", error: cause instanceof Error ? cause.message : "Status request failed." } : file));
        }
      }, 1500);
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Could not start conversion."); }
    finally { setConverting(false); }
  }

  function focusTool(toolName: string) {
    setSelectedTool(toolName);
    if (toolName === "PDF to Word") setTargetFormat("docx");
    else if (toolName === "Word to PDF") setTargetFormat("pdf");
    else if (toolName.includes("Image") || toolName.includes("image")) setTargetFormat("png");
    else if (toolName.includes("Video") || toolName.includes("video")) setTargetFormat("mp4");
    else if (toolName.includes("Audio") || toolName.includes("audio")) setTargetFormat("mp3");
    document.getElementById("try-it")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <main className={dark ? "app dark" : "app light"}>
      <div className="ambient ambient-one" /><div className="ambient ambient-two" /><div className="ambient ambient-three" />
      <div className="grain" />

      <header className="site-header">
        <a href="#home" className="brand" aria-label="ConvertHub AI home"><span className="brand-mark"><ArrowLeftRight size={18} strokeWidth={2.4} /></span><span>ConvertHub<span className="brand-ai"> AI</span></span></a>
        <nav className="nav-links" aria-label="Main navigation">
          <a href="#tools">Explore tools</a><a href="#how-it-works">How it works</a><a href="#faq">FAQs</a>
        </nav>
        <div className="header-actions"><span className="privacy-note"><LockKeyhole size={12} /> Private by design</span><button className="theme-toggle" onClick={() => setDark(!dark)} aria-label="Toggle color theme">{dark ? <Sun size={16} /> : <Moon size={16} />}</button><button className="nav-cta" onClick={() => fileInput.current?.click()}>Let’s convert <ArrowRight size={15} /></button><button className="mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">{menuOpen ? <X size={20} /> : <Menu size={20} />}</button></div>
        <AnimatePresence>{menuOpen && <motion.div className="mobile-popover" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}><a href="#tools" onClick={() => setMenuOpen(false)}>Explore tools</a><a href="#how-it-works" onClick={() => setMenuOpen(false)}>How it works</a><a href="#faq" onClick={() => setMenuOpen(false)}>FAQs</a></motion.div>}</AnimatePresence>
      </header>

      <section className="hero" id="home">
        <div className="hero-copy">
          <div className="eyebrow"><span className="status-dot" /> THE FILE WORKSPACE THAT JUST GETS IT</div>
          <h1>Files, meet<br /><span className="gradient-text">their better half.</span></h1>
          <p className="hero-description">All your conversions, in one calm little corner of the internet. Less fiddling with formats. More getting on with it.</p>
          <div className="hero-actions"><button className="primary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Start converting <ArrowRight size={15} /></button><a className="text-link" href="#tools">Meet your tools <ArrowRight size={15} /></a></div>
          <div className="hero-trust"><div className="avatar-stack"><span>J</span><span>M</span><span>A</span><span>+</span></div><p><strong>2.4 million+</strong> files given a fresh start <span className="rating-stars">★★★★★</span></p></div>
        </div>

        <div className="hero-visual">
          <div className="visual-orbit orbit-outer" /><div className="visual-orbit orbit-inner" />
          <motion.div className="float-chip chip-top" animate={{ y: [0, -8, 0], rotate: [0, 1.5, 0] }} transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}><span className="chip-icon coral"><FileText size={15} /></span><span>Less mess</span><span className="chip-check"><Check size={10} /></span></motion.div>
          <motion.div className="float-chip chip-bottom" animate={{ y: [0, 7, 0], rotate: [0, -1.5, 0] }} transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}><span className="chip-icon mint"><ShieldCheck size={15} /></span><span>Files stay yours</span></motion.div>
          <div className="preview-card glass-card">
            <div className="preview-top"><span className="preview-label"><span className="preview-live" /> YOUR WORKSPACE</span><button className="icon-button" aria-label="More actions"><MoreHorizontal size={18} /></button></div>
            <div className="preview-heading"><div><span className="preview-kicker">RIGHT THIS WAY</span><h3>What are we making today?</h3></div><div className="preview-sparkle"><Sparkles size={18} /></div></div>
            <div className="preview-search"><Search size={16} /><span>Find the perfect tool...</span><kbd><Command size={10} /> K</kbd></div>
            <div className="preview-section-label"><span>QUICK PICKS</span><a href="#tools">See all <ArrowRight size={11} /></a></div>
            <div className="preview-tools">
              {[tools[0], tools[5], tools[1]].map((tool, i) => <button className="preview-tool" key={tool.name} onClick={() => focusTool(tool.name)}><ToolIcon tool={tool} /><span>{tool.name}</span>{i === 0 ? <span className="preview-tool-kicker">POPULAR</span> : <ArrowRight size={13} className="preview-arrow" />}</button>)}
            </div>
            <div className="preview-bottom"><span><LockKeyhole size={11} /> Your files stay yours</span><span><Zap size={11} /> Ready in a moment</span></div>
          </div>
          <div className="hero-scribble"><span>all sorted</span><svg width="74" height="28" viewBox="0 0 74 28" fill="none" aria-hidden="true"><path d="M2 5C17 26 47 27 68 8M68 8l-9-1m9 1-2 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></div>
          <div className="mini-stat"><span className="mini-stat-icon"><Clock3 size={14} /></span><span><strong>20 sec</strong><small>Average conversion</small></span><span className="mini-stat-line" /></div>
        </div>

        <div className="hero-bottom"><span>ONE HOME FOR ALL YOUR FILES</span><span className="hero-bottom-line" /><span><Sparkles size={12} /> A LITTLE MORE MAGIC IN EVERY FILE</span></div>
      </section>

      <section className="comfort-bar" id="how-it-works"><div className="comfort-intro"><span className="tiny-label">GOOD TO KNOW</span><span>Made to feel refreshingly easy.</span></div><div className="comfort-items"><div><span className="comfort-icon lock"><LockKeyhole size={14} /></span><span><strong>Yours means yours</strong><small>Files are kept private</small></span></div><div><span className="comfort-icon spark"><Zap size={14} /></span><span><strong>Quick like a thought</strong><small>Most tasks take seconds</small></span></div><div><span className="comfort-icon smile"><Heart size={14} /></span><span><strong>No hoops to jump</strong><small>Pick a tool. Get started.</small></span></div></div></section>

      <section className="try-section" id="try-it">
        <div className="section-heading try-heading"><div><span className="tiny-label">LET’S GET STUCK IN</span><h2>A good place to <span className="gradient-text">start.</span></h2><p>Drop in a file, choose what happens next. That’s the whole tutorial.</p></div><div className="try-hint"><span>01</span><span className="hint-line" /><span>THREE TINY STEPS</span></div></div>
        <div className={`workspace-card glass-card ${isDragging ? "drop-active" : ""}`} onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setIsDragging(false); }} onDrop={(event) => { event.preventDefault(); setIsDragging(false); if (event.dataTransfer.files.length) processFiles(event.dataTransfer.files); }}>
          <div className="workspace-top"><div className="workspace-tabs"><button className={activeTab === "Everything" ? "active" : ""} onClick={() => setActiveTab("Everything")}><Layers size={14} /> Everything</button><button className={activeTab === "My recent" ? "active" : ""} onClick={() => setActiveTab("My recent")}><Clock3 size={13} /> My recent</button></div><span className="private-pill"><LockKeyhole size={11} /> PRIVATE SESSION</span></div>
          <div className="workspace-main">
            <div className="drop-zone" onClick={() => fileInput.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") fileInput.current?.click(); }}>
              <div className="upload-illustration"><div className="upload-illustration-orbit" /><div className="upload-file"><FileText size={23} /><span>PDF</span></div><div className="upload-arrow"><CloudUpload size={19} /></div><Sparkles size={13} className="upload-star star-one" /><Sparkles size={10} className="upload-star star-two" /></div>
              <h3>{isDragging ? "Lovely, drop it here." : "Give your file a little drop."}</h3><p>Bring one file or a whole bunch. We’ll be gentle.</p>
              <button className="upload-button" onClick={(event) => { event.stopPropagation(); fileInput.current?.click(); }}><CloudUpload size={15} /> Choose your files</button>
              <div className="drop-formats"><span>or just drop them here</span><span>PDF <i>·</i> JPG <i>·</i> MP4 <i>·</i> and plenty more</span></div>
            </div>
            <div className="workspace-divider"><span>THEN, THE FUN PART</span><div /></div>
            <div className="convert-panel"><div className="convert-panel-top"><span className="tiny-label">YOUR LITTLE GAME PLAN</span><span className="step-number">STEP 02 / 03</span></div><h3>How shall we transform it?</h3><div className="tool-select-wrap"><ToolIcon tool={tools.find((tool) => tool.name === selectedTool) ?? tools[0]} size={16} /><select value={selectedTool} onChange={(event) => { const nextTool = event.target.value; setSelectedTool(nextTool); if (nextTool === "PDF to Word") setTargetFormat("docx"); else if (nextTool === "Word to PDF") setTargetFormat("pdf"); else if (nextTool.toLowerCase().includes("image")) setTargetFormat("png"); else if (nextTool.toLowerCase().includes("video")) setTargetFormat("mp4"); else if (nextTool.toLowerCase().includes("audio")) setTargetFormat("mp3"); }} aria-label="Choose a conversion tool">{tools.map((tool) => <option key={tool.name}>{tool.name}</option>)}</select><ChevronDown size={14} /></div><div className="destination-row"><span>Ready to become</span><select value={targetFormat} onChange={(event) => setTargetFormat(event.target.value)} aria-label="Choose a destination format"><option value="pdf">PDF</option><option value="docx">DOCX</option><option value="jpg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option><option value="tiff">TIFF</option><option value="mp4">MP4</option><option value="avi">AVI</option><option value="mkv">MKV</option><option value="mov">MOV</option><option value="webm">WebM</option><option value="gif">GIF</option><option value="mp3">MP3</option><option value="wav">WAV</option><option value="aac">AAC</option><option value="ogg">OGG</option></select></div><Turnstile onToken={setCaptchaToken} resetKey={captchaResetKey} /><div className="convert-button-wrap"><button className="convert-button" disabled={converting || !files.some((file) => file.status === "ready")} onClick={() => void startConversion()}><Sparkles size={14} /> {converting ? "Getting things ready…" : "Make it happen"} <ArrowRight size={14} /></button><span className="conversion-time"><Zap size={10} /> Usually under 20 sec</span></div><div className="output-sparkle"><WandSparkles size={15} /></div></div>
          </div>
          <AnimatePresence>{files.length > 0 && <motion.div className="file-queue" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}><div className="queue-heading"><span>YOUR FILES <span className="queue-count">{files.length}</span></span><button onClick={() => setFiles([])}>Clear all</button></div>{files.map((item) => <div className="queue-item" key={item.id}><span className={`file-type-badge ${item.file.type.startsWith("image") ? "image" : item.file.type.startsWith("video") ? "video" : "doc"}`}>{item.file.type.startsWith("image") ? <ImageIcon size={14} /> : item.file.type.startsWith("video") ? <Film size={14} /> : <FileText size={14} />}</span><div className="queue-file-info"><div><strong>{item.file.name}</strong><span>{prettyBytes(item.file.size)}</span></div><div className="progress-track"><motion.div className="progress-fill" initial={{ width: 0 }} animate={{ width: `${item.progress}%` }} /></div>{item.error && <small className="queue-error-text">{item.error}</small>}</div><div className="queue-state">{item.status === "ready" || item.status === "done" ? <><span className="ready-label"><Check size={11} /> {item.status === "done" ? "Converted" : "Uploaded"}</span><button title={item.status === "done" ? "Download converted file" : "Download original file"} className="download-button" onClick={() => downloadFile(item)}><ArrowDownToLine size={14} /></button></> : item.status === "error" ? <span className="error-label">Failed</span> : <span>{item.status === "processing" ? "Converting" : `${item.progress}%`}</span>}{item.status === "error" && !item.objectPath && <button title="Retry upload" className="download-button" onClick={() => void uploadFile(item.file, item.id)}><Upload size={13} /></button>}<button title="Remove file" onClick={() => removeFile(item.id)} className="remove-file"><X size={14} /></button></div></div>)}</motion.div>}</AnimatePresence>
          <div className="workspace-footer"><span><ShieldCheck size={12} /> Files are encrypted and cleared after processing</span><span>Maximum 100 MB per file <CircleHelp size={12} /></span></div>
        </div>
        <input ref={fileInput} type="file" multiple className="visually-hidden" onChange={(event) => { if (event.target.files) processFiles(event.target.files); event.target.value = ""; }} />
        <div className="after-drop-note"><span className="note-dot" /><span>NOT QUITE READY? <a href="#tools">Have a look around the toolbox <ArrowRight size={12} /></a></span></div>
      </section>

      <section className="tools-section" id="tools" ref={toolsSection}>
        <div className="section-heading tools-heading"><div><span className="tiny-label">A WHOLE TOOLBOX, ACTUALLY</span><h2>Find your <span className="gradient-text">kind of magic.</span></h2><p>A tool for the big jobs, the tiny jobs, and everything in between.</p></div><a className="all-tools-link" href="#tool-directory">Meet the whole toolbox <ArrowRight size={14} /></a></div>
        <div className="featured-strip"><div className="featured-decoration"><div className="featured-sun" /><div className="featured-arc arc-one" /><div className="featured-arc arc-two" /><div className="featured-star"><Sparkles size={15} /></div></div><div className="featured-copy"><span className="featured-label"><Flame size={11} /> THIS WEEK’S FAVORITE</span><h3>A little polish goes a long way.</h3><p>Turn “it’ll do” into “oh, that looks lovely” with one click and a smart little AI assist.</p><button onClick={() => focusTool("Image upscaler")}>Meet the image upscaler <ArrowRight size={13} /></button></div><div className="featured-preview"><div className="featured-image-card"><div className="feature-grid"><span /><span /><span /><span /></div><span className="upscale-pill"><Sparkles size={10} /> 4× clearer</span></div></div></div>
        <div className="tool-filters"><div className="filter-tabs">{categories.map((category) => <button key={category} className={filter === category ? "active" : ""} onClick={() => setFilter(category)}>{category}</button>)}</div><div className="tool-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Looking for something?" aria-label="Search tools" />{search && <button onClick={() => setSearch("")} aria-label="Clear search"><X size={13} /></button>}</div></div>
        <div className="tool-grid" id="tool-directory">{visibleTools.slice(0, 8).map((tool, index) => <motion.button className="tool-card" key={tool.name} initial={{ opacity: 0, y: 12 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: (index % 4) * 0.045 }} onClick={() => focusTool(tool.name)}><div className="tool-card-top"><ToolIcon tool={tool} size={19} /><button className={`favorite-button ${favorites.includes(tool.name) ? "saved" : ""}`} aria-label={`Toggle ${tool.name} favorite`} onClick={(event) => { event.stopPropagation(); setFavorites((existing) => existing.includes(tool.name) ? existing.filter((name) => name !== tool.name) : [...existing, tool.name]); }}><Heart size={15} fill={favorites.includes(tool.name) ? "currentColor" : "none"} /></button></div><h3>{tool.name}</h3><p>{tool.description}</p><div className="tool-card-foot"><span>{tool.category}</span>{tool.hot && <span className="tool-trending"><Flame size={11} /> trending</span>}{tool.fresh && <span className="tool-fresh"><Sparkles size={10} /> just added</span>}<ArrowRight size={13} className="card-arrow" /></div></motion.button>)}</div>
        {visibleTools.length === 0 && <div className="empty-state"><span className="empty-state-icon"><Search size={19} /></span><h3>No matches just yet.</h3><p>Try a different search or browse another category.</p><button onClick={() => { setSearch(""); setFilter("All tools"); }}>Show me everything <ArrowRight size={13} /></button></div>}
        {visibleTools.length > 8 && <button className="load-more" onClick={() => setFilter(filter === "All tools" ? "All tools" : "All tools")}>That’s a lovely start <ArrowRight size={13} /></button>}
      </section>

      <section className="collections-section"><div className="collection-top section-heading"><div><span className="tiny-label">TAKE THE SCENIC ROUTE</span><h2>Good things come in <span className="gradient-text">categories.</span></h2><p>A few friendly starting points, depending on what’s on your desk.</p></div><a className="all-tools-link" href="#tools">Browse all tools <ArrowRight size={14} /></a></div>{groups.map((group) => { const Icon = group.icon; return <div className={`category-row ${group.color}`} key={group.title}><div className="category-heading"><span className="category-icon"><Icon size={16} /></span><div><h3>{group.title}</h3><p>{group.description}</p></div></div><div className="category-tools">{group.tools.map((toolName) => { const tool = tools.find((item) => item.name === toolName)!; return <button key={toolName} onClick={() => focusTool(toolName)}><ToolIcon tool={tool} size={15} /><span>{toolName}</span><ArrowRight size={12} /></button>; })}</div></div>; })}</section>

      <section className="how-section"><div className="how-left"><span className="tiny-label">NO MANUAL REQUIRED</span><h2>Two deep breaths.<br /><span className="gradient-text">Then it’s done.</span></h2><p>We kept the whole thing wonderfully uncomplicated. You have enough to think about already.</p><a className="text-link" href="#try-it">Give it a go <ArrowRight size={14} /></a><div className="how-doodle"><span>easy as that</span><div className="doodle-spark"><Sparkles size={20} /></div></div></div><div className="steps-list"><div className="step-row"><span className="step-index">01</span><span className="step-icon"><Upload size={17} /></span><div><h3>Drop in your file</h3><p>Pick a file, drag a folder, or paste right from your clipboard. Whatever feels easiest.</p></div><span className="step-check"><Check size={12} /></span></div><div className="step-connector" /><div className="step-row"><span className="step-index">02</span><span className="step-icon"><Sparkles size={17} /></span><div><h3>Pick a little transformation</h3><p>PDF to Word? JPG to something fancy? Find your tool and pick a format.</p></div><span className="step-check"><Check size={12} /></span></div><div className="step-connector" /><div className="step-row"><span className="step-index">03</span><span className="step-icon last"><ArrowDownToLine size={17} /></span><div><h3>And away you go</h3><p>Have a peek, download your fresh new file, and get on with your day.</p></div><span className="step-check"><Check size={12} /></span></div></div></section>

      <section className="stats-strip">{stats.map((stat, index) => <div className="stat-item" key={stat.label}><span>{stat.value}</span><small>{stat.label}</small>{index < stats.length - 1 && <i />}</div>)}<div className="stats-note"><div className="avatar-stack stats-avatars"><span>☺</span><span>✦</span><span>♥</span></div><span>Little files. Big relief.</span></div></section>

      <section className="faq-section" id="faq"><div className="faq-intro"><span className="tiny-label">GOOD QUESTIONS, GOOD ANSWERS</span><h2>Wondering<br /><span className="gradient-text">about something?</span></h2><p>A few things people tend to ask before they get started.</p><a href="mailto:hello@converthub.ai" className="faq-contact">Still curious? Say hello <ArrowRight size={13} /></a><div className="faq-ornament"><CircleHelp size={48} strokeWidth={0.8} /><Sparkles size={14} /></div></div><div className="faq-list">{faqs.map(([question, answer], index) => <div className={`faq-item ${faqOpen === index ? "open" : ""}`} key={question}><button onClick={() => setFaqOpen(faqOpen === index ? null : index)}><span className="faq-numeral">0{index + 1}</span><span>{question}</span><span className="faq-toggle">{faqOpen === index ? <X size={13} /> : <ArrowRight size={13} />}</span></button><AnimatePresence>{faqOpen === index && <motion.div className="faq-answer" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}><p>{answer}</p></motion.div>}</AnimatePresence></div>)}</div></section>

      <footer className="site-footer"><div className="footer-top"><a href="#home" className="brand"><span className="brand-mark"><ArrowLeftRight size={17} strokeWidth={2.4} /></span><span>ConvertHub<span className="brand-ai"> AI</span></span></a><div className="footer-tagline">A calmer way to get things done.<span>Made with a little care <Heart size={11} /></span></div><div className="footer-links"><a href="#tools">The toolbox</a><a href="#how-it-works">How it works</a><a href="#faq">FAQ</a><a href="mailto:hello@converthub.ai">Get in touch <ArrowRight size={11} /></a></div></div><div className="footer-bottom"><span>© 2025 ConvertHub AI. Here to make your day easier.</span><span className="footer-status"><span className="status-dot" /> Everything’s ticking along</span><div><a href="#privacy">Privacy, please</a><a href="#terms">The sensible stuff</a><button onClick={() => setDark(!dark)}>{dark ? <Sun size={12} /> : <Moon size={12} />} {dark ? "Light mode" : "Dark mode"}</button></div></div></footer>

      <AnimatePresence>{toast && <motion.div className="toast" initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.97 }}><span className="toast-check"><Check size={13} /></span>{toast}</motion.div>}</AnimatePresence>
      <div className="ambient-cursor" />
    </main>
  );
}
