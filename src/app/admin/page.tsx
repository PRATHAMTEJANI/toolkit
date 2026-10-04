"use client";

import { useCallback, useState } from "react";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Check, Clock3, Database, Globe2, LoaderCircle, RefreshCw, Shield, Users, X, Zap } from "lucide-react";
import Link from "next/link";
import "./admin.css";

type Metric = { name: string; count: number };
type Overview = {
  totals: { visitors: number; activeUsers: number; visitorsToday: number; visitorsThisMonth: number; countries: number; cities: number; uploads: number; downloads: number; conversions: number; errors: number; successRate: number; storedBytes: number; storedOriginals: number };
  breakdowns: { countries: Metric[]; cities: Metric[]; browsers: Metric[]; devices: Metric[]; operatingSystems: Metric[]; tools: Metric[]; formats: Metric[] };
  queue: { status: string; redis: string; waiting: number; active: number; delayed: number; failed: number; completed: number; paused: number; workers: number };
  chart: Array<{ date: string; visitors: number; conversions: number; errors: number }>;
  logs: Array<{ at: string; type: string; tool?: string; format?: string; error?: string }>;
  jobs: Array<{ id: string; status: string; tool: string; target_format: string; error_code?: string; created_at: string }>;
  generatedAt: string;
};

function humanBytes(bytes: number) { const units = ["B", "KB", "MB", "GB", "TB"]; let value = bytes, index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; } return `${value.toFixed(index ? 1 : 0)} ${units[index]}`; }

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (providedToken = token) => {
    if (!providedToken) return;
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/overview", { headers: { authorization: `Bearer ${providedToken}` }, cache: "no-store", credentials: "omit" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Dashboard request failed.");
      setOverview(body); setToken(providedToken);
    } catch (cause) { setOverview(null); setError(cause instanceof Error ? cause.message : "Could not load dashboard."); }
    finally { setLoading(false); }
  }, [token]);

  return <main className="admin-app">
    <header className="admin-header"><Link href="/" className="admin-brand"><span>CH</span><strong>ConvertHub <i>AI</i></strong><small>OPERATIONS</small></Link><div className="admin-head-right"><span className="admin-secure"><Shield size={13} /> Private analytics</span>{overview && <span className="admin-updated">Updated {new Date(overview.generatedAt).toLocaleTimeString()}</span>}<button className="admin-refresh" disabled={loading || !token} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh</button></div></header>
    <div className="admin-content">
      {!overview && <section className="admin-gate"><div className="admin-gate-icon"><Shield size={20} /></div><span className="admin-eyebrow">RESTRICTED OPERATIONS</span><h1>Your workspace, at a glance.</h1><p>Enter the dashboard access token configured on the server. It is held in memory for this page only.</p><form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><input type="password" autoComplete="off" aria-label="Dashboard access token" placeholder="Dashboard access token" value={token} onChange={(event) => setToken(event.target.value)} /><button disabled={loading || !token}>{loading ? <LoaderCircle size={15} className="spin" /> : <Shield size={14} />} Open dashboard</button></form>{error && <div className="admin-error"><X size={14} />{error}</div>}<small>No visitor accounts are created. This token only protects aggregated operational data.</small></section>}
      {overview && <>
        <div className="admin-title-row"><div><span className="admin-eyebrow">A QUIETER WAY TO KEEP AN EYE ON THINGS</span><h1>Good morning, operations.</h1><p>Anonymous traffic, conversion health, and queue activity in one place.</p></div><span className="admin-live"><i /> LIVE OVERVIEW</span></div>
        <section className="admin-metrics">
          <MetricCard label="Total visitors" value={overview.totals.visitors.toLocaleString()} note={`${overview.totals.visitorsThisMonth.toLocaleString()} this month`} icon={<Users size={16} />} tone="purple" />
          <MetricCard label="Active users" value={overview.totals.activeUsers.toLocaleString()} note="Active in last 15 minutes" icon={<Activity size={16} />} tone="green" />
          <MetricCard label="Visitors today" value={overview.totals.visitorsToday.toLocaleString()} note={`${overview.totals.countries} countries · ${overview.totals.cities} cities`} icon={<Globe2 size={16} />} tone="blue" />
          <MetricCard label="Conversion success" value={`${overview.totals.successRate}%`} note={`${overview.totals.conversions} successful · ${overview.totals.errors} errors`} icon={<Zap size={16} />} tone="orange" />
        </section>
        <section className="admin-main-grid">
          <div className="admin-panel admin-chart-panel"><PanelTitle title="Activity over time" subtitle="Visitors, successful conversions and errors · 14 days" /><ActivityChart points={overview.chart} /></div>
          <div className="admin-panel queue-panel"><PanelTitle title="Processing queue" subtitle={overview.queue.redis === "PONG" ? "Redis is connected" : "Queue connection needs attention"} /><div className="queue-status"><span className={overview.queue.redis === "PONG" ? "queue-dot okay" : "queue-dot bad"} />{overview.queue.redis === "PONG" ? "Queue is healthy" : "Queue unavailable"}<span className="worker-count">{overview.queue.workers} workers</span></div><div className="queue-grid"><QueueMetric label="Waiting" value={overview.queue.waiting} /><QueueMetric label="Processing" value={overview.queue.active} /><QueueMetric label="Delayed" value={overview.queue.delayed} /><QueueMetric label="Failed" value={overview.queue.failed} /></div><div className="queue-total"><Check size={13} /> {overview.queue.completed.toLocaleString()} jobs completed <span>{overview.queue.paused ? "· paused" : "· accepting work"}</span></div></div>
        </section>
        <section className="admin-metrics compact-metrics"><MetricCard label="Uploads" value={overview.totals.uploads.toLocaleString()} note={`${overview.totals.storedOriginals} originals in storage`} icon={<ArrowUpFromLine size={15} />} tone="blue" /><MetricCard label="Downloads" value={overview.totals.downloads.toLocaleString()} note="Files retrieved" icon={<ArrowDownToLine size={15} />} tone="green" /><MetricCard label="Stored data" value={humanBytes(overview.totals.storedBytes)} note="Original and converted files" icon={<Database size={15} />} tone="purple" /><MetricCard label="Today’s reach" value={overview.totals.visitorsToday.toLocaleString()} note="Unique anonymous visitors" icon={<Clock3 size={15} />} tone="orange" /></section>
        <section className="admin-breakdowns">{[
          ["Most used tools", overview.breakdowns.tools], ["Most converted formats", overview.breakdowns.formats], ["Countries", overview.breakdowns.countries], ["Cities", overview.breakdowns.cities], ["Browsers", overview.breakdowns.browsers], ["Devices", overview.breakdowns.devices], ["Operating systems", overview.breakdowns.operatingSystems],
        ].map(([title, values]) => <Breakdown key={title as string} title={title as string} items={values as Metric[]} />)}</section>
        <section className="admin-panel admin-table-panel"><PanelTitle title="Recent processing jobs" subtitle="Latest conversion attempts" /><div className="admin-table-scroll"><table><thead><tr><th>Tool</th><th>Output</th><th>Status</th><th>Job ID</th><th>Created</th></tr></thead><tbody>{overview.jobs.length ? overview.jobs.map((job) => <tr key={job.id}><td>{job.tool}</td><td>.{job.target_format.toUpperCase()}</td><td><span className={`job-pill ${job.status}`}>{job.status}</span>{job.error_code && <span className="job-error">{job.error_code}</span>}</td><td className="admin-mono">{job.id.slice(0, 8)}…</td><td>{new Date(job.created_at).toLocaleString()}</td></tr>) : <tr><td colSpan={5} className="admin-empty">No conversion jobs have been submitted.</td></tr>}</tbody></table></div></section>
        <section className="admin-panel admin-table-panel"><PanelTitle title="Operational logs" subtitle="Anonymous events only · no raw IP or cookie data" /><div className="admin-table-scroll"><table><thead><tr><th>Time</th><th>Event</th><th>Tool</th><th>Format</th><th>Error</th></tr></thead><tbody>{overview.logs.length ? overview.logs.map((log, index) => <tr key={`${log.at}-${index}`}><td>{new Date(log.at).toLocaleString()}</td><td><span className={`event-mark ${log.type.includes("failed") ? "failed" : ""}`} />{log.type.replaceAll("_", " ")}</td><td>{log.tool ?? "—"}</td><td>{log.format ?? "—"}</td><td className={log.error ? "job-error" : ""}>{log.error ?? "—"}</td></tr>) : <tr><td colSpan={5} className="admin-empty">No events recorded yet.</td></tr>}</tbody></table></div></section>
        <footer className="admin-footer"><span><Shield size={12} /> Anonymous data only</span><span>Country data uses trusted hosting geo headers when enabled. IP addresses are not stored.</span></footer>
      </>}
    </div>
  </main>;
}

function MetricCard({ label, value, note, icon, tone }: { label: string; value: string; note: string; icon: React.ReactNode; tone: string }) {
  return <div className="admin-metric"><span className={`metric-icon ${tone}`}>{icon}</span><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small></div>;
}
function PanelTitle({ title, subtitle }: { title: string; subtitle: string }) { return <div className="admin-panel-title"><div><h2>{title}</h2><p>{subtitle}</p></div></div>; }
function QueueMetric({ label, value }: { label: string; value: number }) { return <div className="queue-metric"><small>{label}</small><strong>{value.toLocaleString()}</strong></div>; }
function Breakdown({ title, items }: { title: string; items: Metric[] }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return <div className="admin-panel breakdown-panel"><PanelTitle title={title} subtitle={items.length ? `${items.length} leading entries` : "No data yet"} /><div className="breakdown-list">{items.length ? items.slice(0, 6).map((item) => <div className="breakdown-item" key={item.name}><div><span>{item.name}</span><strong>{item.count.toLocaleString()}</strong></div><i><b style={{ width: `${Math.max(3, item.count / max * 100)}%` }} /></i></div>) : <p className="admin-no-data">Nothing to show yet.</p>}</div></div>;
}
function ActivityChart({ points }: { points: Overview["chart"] }) {
  const max = Math.max(1, ...points.flatMap((point) => [point.visitors, point.conversions, point.errors]));
  const chartWidth = Math.max(500, points.length * 48);
  const makePath = (field: "visitors" | "conversions" | "errors") => points.map((point, index) => `${index ? "L" : "M"} ${index * (chartWidth / Math.max(1, points.length - 1))} ${154 - point[field] / max * 130}`).join(" ");
  return <div className="chart-scroll"><svg viewBox={`-4 0 ${chartWidth + 8} 180`} preserveAspectRatio="none" role="img" aria-label="14-day visitor, conversion, and error trend"><defs><linearGradient id="visitor-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ae91f0" stopOpacity=".23" /><stop offset="1" stopColor="#ae91f0" stopOpacity="0" /></linearGradient></defs>{[24, 67, 110, 154].map((y) => <line key={y} x1="0" x2={chartWidth} y1={y} y2={y} stroke="currentColor" opacity=".1" />)}<path d={`${makePath("visitors")} L ${chartWidth} 154 L 0 154 Z`} fill="url(#visitor-fill)" /><path d={makePath("visitors")} fill="none" stroke="#bca1f5" strokeWidth="2.5" vectorEffect="non-scaling-stroke" /><path d={makePath("conversions")} fill="none" stroke="#83d4a5" strokeWidth="2" vectorEffect="non-scaling-stroke" /><path d={makePath("errors")} fill="none" stroke="#ed9ba8" strokeWidth="2" vectorEffect="non-scaling-stroke" />{points.map((point, index) => <text key={point.date} x={index * (chartWidth / Math.max(1, points.length - 1))} y="174" textAnchor="middle" fill="currentColor" opacity=".55" fontSize="8">{new Date(`${point.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>)}</svg><div className="chart-legend"><span><i className="purple" /> Visitors</span><span><i className="green" /> Conversions</span><span><i className="rose" /> Errors</span></div></div>;
}
