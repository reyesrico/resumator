import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, FileCheck2,
  FileText, LayoutTemplate, Link2, LoaderCircle, LockKeyhole, RotateCcw, ShieldCheck,
  Sparkles, UploadCloud, WandSparkles, X,
} from "lucide-react";
import type { Edit, Health, RenderResult, ResumeInfo, TailorResult } from "../shared/types";
import { api, json } from "./api";
import TextDiff, { OriginalContext } from "./TextDiff";
import { hasTextChange } from "../shared/changes";

type Busy = "upload" | "job" | "tailor" | "render" | "approve" | "download" | "delete" | null;

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [versions, setVersions] = useState<ResumeInfo[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [jobMode, setJobMode] = useState<"link" | "text">("link");
  const [jobUrl, setJobUrl] = useState("");
  const [jobText, setJobText] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<TailorResult | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [render, setRender] = useState<RenderResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [approved, setApproved] = useState(false);
  const [preview, setPreview] = useState<"compare" | "original" | "tailored">("compare");
  const [allowWordConversion, setAllowWordConversion] = useState(false);
  const [help, setHelp] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reviewSection = useRef<HTMLElement>(null);

  useEffect(() => {
    void api<Health>("/health").then(setHealth).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "The server is unavailable.");
    });
    void api<{ versions: ResumeInfo[]; latestId: string | null }>("/resumes")
      .then((library) => {
        setVersions(library.versions);
        setResume(library.versions.find((version) => version.id === library.latestId) ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load the saved resume library."))
      .finally(() => setLoadingLibrary(false));
  }, []);

  async function run(task: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(task); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again."); }
    finally { setBusy(null); }
  }
  function clearResult() {
    setResult(null); setEdits([]); setRender(null); setDirty(false); setReviewed(false); setApproved(false);
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!/\.(pdf|docx?)$/i.test(file.name) || file.size > 10 * 1024 * 1024) {
      setError("Choose a PDF, DOC, or DOCX resume, up to 10 MB."); return;
    }
    await run("upload", async () => {
      const data = new FormData(); data.append("resume", file);
      const uploaded = await api<ResumeInfo>("/resumes", { method: "POST", body: data });
      setResume(uploaded); setVersions((current) => [uploaded, ...current]); clearResult();
    });
  }
  async function deleteVersion() {
    if (!resume) return;
    await run("delete", async () => {
      await api(`/resumes/${resume.id}`, { method: "DELETE" });
      const library = await api<{ versions: ResumeInfo[]; latestId: string | null }>("/resumes");
      setVersions(library.versions);
      setResume(library.versions.find((version) => version.id === library.latestId) ?? null);
      clearResult();
    });
  }
  function drop(event: DragEvent) {
    event.preventDefault(); setDragging(false);
    if (!busy) void upload(event.dataTransfer.files[0]);
  }
  async function loadJob() {
    await run("job", async () => {
      const loaded = await api<{ text: string }>("/job", json({ url: jobUrl }));
      setJobText(loaded.text); setJobMode("text"); clearResult();
    });
  }
  async function tailor() {
    if (!resume) return;
    await run("tailor", async () => {
      clearResult();
      const tailored = await api<TailorResult>(`/resumes/${resume.id}/tailor`, json({ jobText, consent }));
      setResult(tailored); setEdits(tailored.edits); setRender(tailored.render); setPreview("compare");
      setTimeout(() => reviewSection.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    });
  }
  function changeEdit(id: string, text: string) {
    setEdits((current) => current.map((edit) => edit.id === id ? { ...edit, text } : edit));
    setDirty(true); setReviewed(false); setApproved(false);
  }
  async function refreshPreview() {
    if (!resume) return;
    await run("render", async () => {
      setRender(null); setReviewed(false); setApproved(false);
      const rendered = await api<RenderResult>(`/resumes/${resume.id}/render`, json({ edits }));
      setRender(rendered); setDirty(false);
    });
  }
  async function approve() {
    if (!resume || !render) return;
    await run("approve", async () => {
      await api(`/resumes/${resume.id}/approve`, json({ revision: render.revision, reviewed }));
      setApproved(true);
    });
  }
  async function download(format: "pdf" | "doc" | "docx") {
    if (!resume) return;
    await run("download", async () => {
      const response = await fetch(`/api/resumes/${resume.id}/download/${format}${allowWordConversion ? "?allowConversion=true" : ""}`);
      if (!response.ok) {
        const data: { error: string } = await response.json();
        throw new Error(data.error);
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${resume.name.replace(/\.[^.]+$/, "")}-tailored.${format}`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const canTailor = resume && jobText.trim().length >= 100 && consent && health?.claude && !busy && !loadingLibrary;
  const setupMissing = health && (!health.claude || !health.libreoffice || !health.pdfNative);
  const visibleEdits = edits.filter((edit) => {
    const original = resume?.paragraphs.find((paragraph) => paragraph.id === edit.id);
    return original && hasTextChange(original.text, edit.text);
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Resumator home"><span className="brand-mark"><FileText size={20} /></span>resumator<span className="brand-dot">.</span></a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <div className="nav-item active"><WandSparkles size={18} /> Resume studio <span>01</span></div>
        <div className="sidebar-guide">
          <p>A little polish.<br />A bigger opportunity.</p>
          <div className={`guide-step ${resume ? "complete" : ""}`}><span>{resume ? <Check size={12} /> : "1"}</span><div>Your resume<small>Start with your experience</small></div></div>
          <div className={`guide-step ${jobText.length >= 100 ? "complete" : ""}`}><span>{jobText.length >= 100 ? <Check size={12} /> : "2"}</span><div>The opportunity<small>Tell us about the role</small></div></div>
          <div className={`guide-step ${result ? "complete" : ""}`}><span>{result ? <Check size={12} /> : "3"}</span><div>A better fit<small>Review, refine, download</small></div></div>
        </div>
        <div className="sidebar-bottom"><span className="claude-symbol">✳</span><div>Thoughtfully powered by Claude<small>Your experience stays yours.</small></div></div>
      </aside>

      <div className="main-shell">
        <header className="topbar"><div>Workspace <ChevronRight size={14} /><span>Resume studio</span></div><button className="text-button" onClick={() => setHelp(!help)}><CircleHelp size={16} /> How it works</button></header>
        <main>
          <div className="intro"><div><span className="eyebrow">RESUME STUDIO</span><h1>Your next role.<br /><em>Your actual experience.</em></h1><p>Targeted wording changes. Original facts protected.<br className="desktop-break" /> Compare every edit before anything leaves your hands.</p></div><div className="intro-stamp"><ShieldCheck size={20} /><span>Facts first.<br /><strong>Always.</strong></span></div></div>

          {help && <section className="notice info"><strong>Your experience, not invented experience.</strong><p>Upload your resume, import or paste the job description, and ask Claude to suggest factual wording changes. Review every edit and the PDF preview before approving downloads. Claude API billing is separate from a Claude chat subscription.</p><p>Your original uploads are saved in this studio's private library until you delete them: on your computer for local use, or on the server for a hosted studio. Each upload adds a version; the latest loads automatically next time. Your browser cookie identifies your library: clearing it loses access, not the stored files. Tailored copies never replace the basis. Temporary previews expire after inactivity or restart. Sending text to Anthropic requires your consent.</p></section>}
          {setupMissing && <section className="notice setup"><div><strong>One-time setup needed</strong><p>{[
            !health.claude && "Add ANTHROPIC_API_KEY to .env",
            !health.libreoffice && "Install LibreOffice",
            !health.pdfNative && "Install PyMuPDF for native PDF editing",
          ].filter(Boolean).join(" · ")}. See the README, then restart the app and refresh.</p></div><span className="setup-pill">LOCAL PREVIEW</span></section>}
          {error && <div className="notice error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><X size={17} /></button></div>}

          <div className="studio-grid">
            <div className="input-column">
              <section className="card">
                <div className="section-heading"><span className="number">01</span><div><h2>Your resume library</h2><p>Saved in this studio. Latest version selected by default.</p></div>{resume && <CheckCheck className="green" size={20} />}</div>
                <input ref={input} type="file" accept=".pdf,.doc,.docx" className="visually-hidden" aria-label="Upload resume" disabled={Boolean(busy) || loadingLibrary} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
                {loadingLibrary ? <p className="field-hint">Loading your saved resumes…</p> : resume ? <><div className="uploaded-file"><span className="file-icon"><FileCheck2 size={26} /></span><div><strong>{resume.name}</strong><small>Version {resume.version} · {resume.format.toUpperCase()} · {resume.originalPages} {resume.originalPages === 1 ? "page" : "pages"}{versions[0]?.id === resume.id ? " · Latest basis" : " · Older basis selected"}</small></div></div><div className="library-controls"><div><label htmlFor="resume-version">Resume version</label><select id="resume-version" value={resume.id} disabled={Boolean(busy)} onChange={(event) => { setResume(versions.find((version) => version.id === event.target.value) ?? null); clearResult(); }}>{versions.map((version, index) => <option key={version.id} value={version.id}>v{version.version}{index === 0 ? " · Latest" : ""} · {version.name} · {version.createdAt ? new Date(version.createdAt).toLocaleDateString() : ""}</option>)}</select></div><button className="secondary-button" disabled={Boolean(busy)} onClick={() => input.current?.click()}><UploadCloud size={15} /> {busy === "upload" ? "Saving…" : "Upload new version"}</button></div><details className="delete-version"><summary>Manage this version</summary><p>Deleting removes this original from your local library. This cannot be undone here.</p><button className="text-button" disabled={Boolean(busy)} onClick={() => void deleteVersion()}>Delete version {resume.version} permanently</button></details></> :
                  <button className={`drop-zone ${dragging ? "dragging" : ""}`} disabled={Boolean(busy) || loadingLibrary} onClick={() => input.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
                    <span className="upload-icon">{busy === "upload" ? <LoaderCircle className="spin" size={25} /> : <UploadCloud size={25} />}</span><strong>{busy === "upload" ? "Reading your resume…" : "Drop your resume here"}</strong><span>or <b>browse files</b> to get started</span><small>PDF, DOC, or DOCX · Up to 10 MB</small>
                  </button>}
                <div className="privacy-note"><LockKeyhole size={13} /> Originals saved on the studio server until deleted. Never sent to Claude without consent.</div>
              </section>

              <section className="card">
                <div className="section-heading"><span className="number">02</span><div><h2>Meet your next opportunity</h2><p>What role do you have your eye on?</p></div></div>
                <div className="tabs" role="tablist" aria-label="Job description input"><button role="tab" aria-selected={jobMode === "link"} className={jobMode === "link" ? "selected" : ""} onClick={() => setJobMode("link")}><Link2 size={15} /> Job link</button><button role="tab" aria-selected={jobMode === "text"} className={jobMode === "text" ? "selected" : ""} onClick={() => setJobMode("text")}><FileText size={15} /> Paste description</button></div>
                {jobMode === "link" ? <div className="job-link"><label htmlFor="job-url">Job posting URL</label><div className="url-input"><Link2 size={17} /><input id="job-url" type="url" placeholder="https://company.com/careers/your-next-role" value={jobUrl} disabled={Boolean(busy)} onChange={(event) => { setJobUrl(event.target.value); setJobText(""); clearResult(); }} /><button aria-label="Import job description" title="Import job description" disabled={!jobUrl || Boolean(busy)} onClick={() => void loadJob()}>{busy === "job" ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={18} />}</button></div><p className="field-hint">A public job link works best. If a site blocks access, paste the description.</p>{jobText && <span className="imported"><Check size={13} /> Description loaded · {jobText.length.toLocaleString()} characters</span>}</div> :
                  <div className="job-description"><label htmlFor="job-description">Job description</label><textarea id="job-description" placeholder="Paste the responsibilities, requirements, and anything else that matters for this role…" value={jobText} maxLength={25000} disabled={Boolean(busy)} onChange={(event) => { setJobText(event.target.value); clearResult(); }} rows={7} /><div className="field-hint">{jobText.length.toLocaleString()} / 25,000 characters · At least 100 characters</div></div>}
              </section>

              <div className="consent"><input id="consent" type="checkbox" checked={consent} disabled={Boolean(busy)} onChange={(event) => setConsent(event.target.checked)} /><label htmlFor="consent">I agree to send my resume text and this job description to Anthropic for AI processing. API usage may incur charges.</label></div>
              <button className="primary-button tailor-button" disabled={!canTailor} onClick={() => void tailor()}>{busy === "tailor" ? <LoaderCircle className="spin" size={19} /> : <Sparkles size={18} />}{busy === "tailor" ? "Finding the right words…" : result ? "Tailor again with Claude" : "Tailor my resume"}{busy !== "tailor" && <ArrowRight size={17} />}</button>
              <p className="button-note">{busy === "tailor" ? "Checking the page count. A shorter second pass may take a few minutes." : "Your story, more relevant. No made-up skills. No new template."}</p>
            </div>

            <aside className="promise-column">
              <div className="promise-card"><span className="eyebrow">A BETTER FIT. STILL YOU.</span><div className="paper-illustration" aria-hidden="true"><div className="paper-name" /><div className="paper-caption" /><div className="paper-divider" /><div className="paper-title" /><div className="paper-lines"><i /><i /><i /></div><div className="paper-title short" /><div className="paper-lines"><i /><i /><i /><i /></div><span className="paper-tag"><Check size={12} /> Your design, refined</span><span className="paper-spark"><Sparkles size={19} /></span></div><h3>A refresh, not a reinvention.</h3><p>The right words can open the right door.<br />We focus on the fit, not changing your story.</p><div className="promise-list"><div><LayoutTemplate size={18} /><span><strong>Your template, respected</strong><small>Existing structure and styles retained where possible.</small></span></div><div><FileText size={18} /><span><strong>One page. Every final PDF.</strong><small>Measured by rendering, not guesswork.</small></span></div><div><ShieldCheck size={18} /><span><strong>Real experience only</strong><small>Review every suggestion before you download.</small></span></div></div><div className="fidelity-note">PDF and DOC conversion may alter design. Exact template preservation is not guaranteed.</div></div>
              <div className="tip"><span>✳</span><p><strong>A small tip</strong>Start with a one-page DOCX for the best chance of keeping your design intact.</p></div>
            </aside>
          </div>

          {result && resume && <section className="review-section" ref={reviewSection}>
            <div className="review-heading"><div><span className="eyebrow">03 / REVIEW & COMPARE</span><h2>See exactly what changed.</h2><p>{result.summary}</p></div><span className={`page-badge ${render?.ready ? "" : "blocked"}`}>{render ? render.ready ? "1 page · ready for review" : "Download blocked" : "Preview needed"}{render?.ready && <Check size={14} />}</span></div>
            {result.keywords.length > 0 && <div className="keywords"><span>Supported keywords</span>{result.keywords.map((word, index) => <span className="keyword" key={`${word}-${index}`}>{word}</span>)}</div>}
            {[...(result.notices ?? []), ...resume.warnings, ...(render?.warnings ?? [])].map((warning, index) => <div className="review-warning" key={index}>{warning}</div>)}
            <div className="review-navigation"><a href="#wording-changes">1. Review {visibleEdits.length} wording changes</a><a href="#layout-comparison">2. Check layout & download</a><span><del>Removed wording</del><ins>Added wording</ins></span></div>
            <div className="review-grid"><div className="edits-list" id="wording-changes"><div className="review-subheading"><h3>1. What changed, and why</h3><span>{visibleEdits.length} actual {visibleEdits.length === 1 ? "change" : "changes"} · unchanged text omitted</span></div>
              {visibleEdits.length === 0 && <p className="empty-edits">No factual, meaningful wording changes remain. Unchanged suggestions are not counted. Any unsafe suggestions blocked by the server are listed above.</p>}
              {visibleEdits.map((edit, index) => {
                const paragraph = resume.paragraphs.find((paragraph) => paragraph.id === edit.id)!;
                return <article className="edit-card" key={edit.id}><div className="edit-label">CHANGE {index + 1}<button className="text-button" disabled={Boolean(busy)} onClick={() => { setEdits((current) => current.filter((item) => item.id !== edit.id)); setDirty(true); setReviewed(false); setApproved(false); }}>Reject · keep original</button></div><TextDiff before={paragraph.text} after={edit.text} /><div className="edit-reason"><strong>Why this change</strong><p>{edit.reason}</p></div>{paragraph.context && <details className="edit-context"><summary>Where this appears in your resume</summary><small>Original paragraph. Highlighted text is the portion changed above.</small><OriginalContext context={paragraph.context} text={paragraph.text} /></details>}<details className="edit-manually"><summary>Edit replacement text</summary><textarea aria-label={`Replacement for change ${index + 1}`} value={edit.text} maxLength={8000} disabled={Boolean(busy)} onChange={(event) => changeEdit(edit.id, event.target.value)} rows={4} /></details></article>;
              })}
              <button className="secondary-button" disabled={Boolean(busy) || !dirty} onClick={() => void refreshPreview()}>{busy === "render" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />} Update preview with my edits</button>
            </div><div className="preview-column" id="layout-comparison"><div className="preview-toolbar"><h3>2. Check layout & download</h3><div className="preview-toggle">{(["compare", "original", "tailored"] as const).map((mode) => <button key={mode} className={preview === mode ? "selected" : ""} onClick={() => setPreview(mode)}>{mode === "compare" ? "Side by side" : mode === "original" ? "Original" : "Tailored"}</button>)}</div></div>
              <div className={`document-comparison ${preview === "compare" ? "side-by-side" : ""}`}>
                {preview !== "tailored" && <div><div className="document-label">ORIGINAL <span>Source of truth</span></div><iframe title="Original resume PDF preview" className="pdf-preview" src={`/api/resumes/${resume.id}/original#toolbar=0&view=FitH`} /></div>}
                {preview !== "original" && <div><div className="document-label">TAILORED <span>{dirty ? "Out of date" : render?.ready ? "Review required" : "Not ready for download"}</span></div>{render ? <iframe title="Tailored resume PDF preview" className="pdf-preview" src={`/api/resumes/${resume.id}/preview?revision=${render.revision}#toolbar=0&view=FitH`} /> : <div className="preview-placeholder">Update the preview to see your changes.</div>}</div>}
              </div>
              {dirty && <p className="review-warning">This preview is out of date. Update it before approving.</p>}
              <div className="approval"><input id="reviewed" type="checkbox" checked={reviewed} disabled={dirty || !render?.ready || Boolean(busy)} onChange={(event) => { setReviewed(event.target.checked); setApproved(false); }} /><label htmlFor="reviewed">I checked the wording for accuracy and compared both previews for layout, readability, and clipped text.</label></div>
              {resume.format === "pdf" && <div className="approval"><input id="word-conversion" type="checkbox" checked={allowWordConversion} onChange={(event) => setAllowWordConversion(event.target.checked)} /><label htmlFor="word-conversion">Also allow reconstructed Word copies. These may change the design; download PDF to retain the original layout.</label></div>}
              {!approved ? <button className="primary-button" disabled={!reviewed || dirty || !render?.ready || Boolean(busy)} onClick={() => void approve()}><CheckCheck size={17} /> Approve this version</button> : <div className="download-buttons">{(["pdf", "docx", "doc"] as const).map((format) => <button className={format === "pdf" ? "primary-button" : "secondary-button"} key={format} disabled={Boolean(busy) || (format !== "pdf" && resume.format === "pdf" && !allowWordConversion)} onClick={() => void download(format)}><ArrowDownToLine size={16} /> {format.toUpperCase()}</button>)}</div>}
              <p className="field-hint">The PDF is the measured output. Word may reflow on other devices. For PDF sources, Word exports are explicitly opt-in reconstructed copies.</p>
            </div></div>
          </section>}
          <footer><span className="footer-brand">resumator.</span><span>Built for your next chapter, not a different you.</span><span><LockKeyhole size={12} /> Private by intention</span></footer>
        </main>
      </div>
    </div>
  );
}
