import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  ArrowDownToLine, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, FileCheck2,
  FileText, LayoutTemplate, LoaderCircle, LockKeyhole, RotateCcw, ShieldCheck,
  Sparkles, UploadCloud, WandSparkles, X,
} from "lucide-react";
import type { Edit, RenderResult, ResumeInfo, TailorResult } from "../shared/types";
import { api, json } from "./api";
import TextDiff, { OriginalContext } from "./TextDiff";
import { hasTextChange } from "../shared/changes";
import { hasSessionKey, setSessionKey } from "./browser/claude";
import { downloadDocument, saveFile } from "./browser/studio";
import DocumentPreview from "./DocumentPreview";

type Busy = "upload" | "tailor" | "render" | "approve" | "download" | "delete" | null;

export default function App() {
  const [resume, setResume] = useState<ResumeInfo | null>(null);
  const [versions, setVersions] = useState<ResumeInfo[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
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
  const [keyReady,setKeyReady]=useState(hasSessionKey());
  const [originalReady,setOriginalReady]=useState(false);
  const [tailoredReady,setTailoredReady]=useState(false);
  const keyInput=useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reviewSection = useRef<HTMLElement>(null);

  useEffect(() => {
    void api<{ versions: ResumeInfo[]; latestId: string | null }>("/resumes")
      .then((library) => {
        setVersions(library.versions);
        setResume(library.versions.find((version) => version.id === library.latestId) ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load the saved resume library."))
      .finally(() => setLoadingLibrary(false));
    const clearKey=()=>{
      setSessionKey("");setKeyReady(false);
      if(keyInput.current)keyInput.current.value="";
    };
    window.addEventListener("pagehide",clearKey);
    return()=>window.removeEventListener("pagehide",clearKey);
  }, []);

  async function run(task: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(task); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Something went wrong. Please try again."); }
    finally { setBusy(null); }
  }
  function clearResult() {
    setResult(null); setEdits([]); setRender(null); setDirty(false); setReviewed(false); setApproved(false);
    setOriginalReady(false);setTailoredReady(false);
  }
  async function upload(file?: File) {
    if (!file) return;
    if (!/\.(pdf|docx)$/i.test(file.name) || file.size > 10 * 1024 * 1024) {
      setError("Choose a PDF or DOCX resume, up to 10 MB. Save legacy .doc files as DOCX or PDF first."); return;
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
  async function download(original=false,draft=false) {
    if (!resume) return;
    await run("download", async () => {
      const file=await downloadDocument(resume.id,original,draft);
      saveFile(file.bytes,file.name,file.type);
    });
  }
  const canTailor = resume && jobText.trim().length >= 100 && consent && keyReady && !busy && !loadingLibrary;
  const visibleEdits = edits.filter((edit) => {
    const original = resume?.paragraphs.find((paragraph) => paragraph.id === edit.id);
    return original && hasTextChange(original.text, edit.text);
  });

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="./" aria-label="Resumator home"><span className="brand-mark"><FileText size={20} /></span>resumator<span className="brand-dot">.</span></a>
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

          {help && <section className="notice info"><strong>Browser-only. Your device, your files.</strong><p>PDF and DOCX processing runs on this device. Original versions stay in this browser's IndexedDB, not on GitHub or a Resumator server. Clearing website data, private browsing, or browser storage eviction can remove them; use “Download original backup” to save a copy in Files or Downloads. Other devices and browsers have separate libraries.</p><p>Enter your own Anthropic API key for this page session. It is kept only in memory, cleared by refresh or closing the page, and sent directly to Anthropic with approved requests. Browser extensions or compromised page code could access an in-memory key. Never use a shared key here. Claude API usage is billed separately; free hosting does not mean free API calls.</p><p>PDF export requires a measured one-page result. DOCX is available as an editable draft only: browser previews cannot certify Word pagination. Legacy .doc and automatic job-URL import are not supported; paste the job text.</p></section>}
          <section className="card session-key"><div className="section-heading"><span className="number"><LockKeyhole size={17}/></span><div><h2>Your Claude key · this page session only</h2><p>Direct to Anthropic. Not saved, logged, or sent to GitHub.</p></div></div><label htmlFor="claude-key">Anthropic API key</label><div className="key-controls"><input ref={keyInput} id="claude-key" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="Enter your own API key" disabled={Boolean(busy)} onChange={(event)=>{setSessionKey(event.target.value);setKeyReady(hasSessionKey());}}/><button className="secondary-button" disabled={Boolean(busy)||!keyReady} onClick={()=>{setSessionKey("");setKeyReady(false);if(keyInput.current)keyInput.current.value="";}}>Clear key</button></div><p className="field-hint">{keyReady?"Key held in page memory. Refresh or close this page to clear it.":"No key stored. Enter it to enable tailoring; reviewing and saving originals needs no key."} Anthropic API charges still apply.</p></section>
          {error && <div className="notice error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><X size={17} /></button></div>}

          <div className="studio-grid">
            <div className="input-column">
              <section className="card">
                <div className="section-heading"><span className="number">01</span><div><h2>Your resume library</h2><p>Saved in this browser, on this device. Latest upload is the default.</p></div>{resume && <CheckCheck className="green" size={20} />}</div>
                <input ref={input} type="file" accept=".pdf,.docx" className="visually-hidden" aria-label="Upload resume" disabled={Boolean(busy) || loadingLibrary} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
                {loadingLibrary ? <p className="field-hint">Loading your saved resumes…</p> : resume ? <><div className="uploaded-file"><span className="file-icon"><FileCheck2 size={26} /></span><div><strong>{resume.name}</strong><small>Version {resume.version} · {resume.format.toUpperCase()} · {resume.originalPages ? `${resume.originalPages} ${resume.originalPages===1?"page":"pages"}`:"Page count unverified"}{versions[0]?.id === resume.id ? " · Latest basis" : " · Older basis selected"}</small></div></div><div className="library-controls"><div><label htmlFor="resume-version">Resume version</label><select id="resume-version" value={resume.id} disabled={Boolean(busy)} onChange={(event) => { setResume(versions.find((version) => version.id === event.target.value) ?? null); clearResult(); }}>{versions.map((version, index) => <option key={version.id} value={version.id}>v{version.version}{index === 0 ? " · Latest" : ""} · {version.name} · {version.createdAt ? new Date(version.createdAt).toLocaleDateString() : ""}</option>)}</select></div><button className="secondary-button" disabled={Boolean(busy)} onClick={() => input.current?.click()}><UploadCloud size={15} /> {busy === "upload" ? "Saving…" : "Upload new version"}</button></div><button className="text-button backup-button" disabled={Boolean(busy)} onClick={()=>void download(true)}>Download original backup</button><details className="delete-version"><summary>Manage this version</summary><p>Deleting removes this original from this browser. Save a backup first; this cannot be undone here.</p><button className="text-button" disabled={Boolean(busy)} onClick={() => void deleteVersion()}>Delete version {resume.version} permanently</button></details></> :
                  <button className={`drop-zone ${dragging ? "dragging" : ""}`} disabled={Boolean(busy) || loadingLibrary} onClick={() => input.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
                    <span className="upload-icon">{busy === "upload" ? <LoaderCircle className="spin" size={25} /> : <UploadCloud size={25} />}</span><strong>{busy === "upload" ? "Reading your resume…" : "Drop your resume here"}</strong><span>or <b>browse files</b> to get started</span><small>PDF or DOCX · Up to 10 MB · Processed on your device</small>
                  </button>}
                <div className="privacy-note"><LockKeyhole size={13} /> Device-local storage. Download backups; clearing website data can erase this library.</div>
              </section>

              <section className="card">
                <div className="section-heading"><span className="number">02</span><div><h2>Meet your next opportunity</h2><p>What role do you have your eye on?</p></div></div>
                <div className="job-description"><label htmlFor="job-description">Job description</label><textarea id="job-description" placeholder="Paste the responsibilities, requirements, and anything else that matters for this role…" value={jobText} maxLength={25000} disabled={Boolean(busy)} onChange={(event) => { setJobText(event.target.value); clearResult(); }} rows={7} /><div className="field-hint">{jobText.length.toLocaleString()} / 25,000 characters · At least 100 characters. Paste text: most job sites block direct browser URL imports.</div></div>
              </section>

              <div className="consent"><input id="consent" type="checkbox" checked={consent} disabled={Boolean(busy)} onChange={(event) => setConsent(event.target.checked)} /><label htmlFor="consent">I agree to send my resume text and this job description to Anthropic for AI processing. API usage may incur charges.</label></div>
              <button className="primary-button tailor-button" disabled={!canTailor} onClick={() => void tailor()}>{busy === "tailor" ? <LoaderCircle className="spin" size={19} /> : <Sparkles size={18} />}{busy === "tailor" ? "Finding the right words…" : result ? "Tailor again with Claude" : "Tailor my resume"}{busy !== "tailor" && <ArrowRight size={17} />}</button>
              <p className="button-note">{busy === "tailor" ? "Requesting wording suggestions, then checking the document locally." : "One Claude request per click. Local preview edits do not make AI calls."}</p>
            </div>

            <aside className="promise-column">
              <div className="promise-card">
                <span className="eyebrow">A BETTER FIT. STILL YOU.</span>
                <div className="paper-illustration" aria-hidden="true"><div className="paper-name" /><div className="paper-caption" /><div className="paper-divider" /><div className="paper-title" /><div className="paper-lines"><i /><i /><i /></div><div className="paper-title short" /><div className="paper-lines"><i /><i /><i /><i /></div><span className="paper-tag"><Check size={12} /> Your design, refined</span><span className="paper-spark"><Sparkles size={19} /></span></div>
                <h3>A refresh, not a reinvention.</h3><p>The right words can open the right door.<br />We focus on the fit, not changing your story.</p>
                <div className="promise-list">
                  <div><LayoutTemplate size={18} /><span><strong>Your template, respected</strong><small>Original styles retained. Unsupported edits blocked.</small></span></div>
                  <div><FileText size={18} /><span><strong>One page. Every final PDF.</strong><small>Actual PDF page count, not a Word preview estimate.</small></span></div>
                  <div><ShieldCheck size={18} /><span><strong>Real experience only</strong><small>Review every suggestion before you download.</small></span></div>
                </div>
                <div className="fidelity-note">Review the layout before approval. DOCX previews are approximate; DOCX exports are drafts, not page-certified PDFs.</div>
              </div>
              <div className="tip"><span>✳</span><p><strong>A small tip</strong>Start with a one-page PDF for measured one-page export. DOCX downloads are editable drafts.</p></div>
            </aside>
          </div>

          {result && resume && <section className="review-section" ref={reviewSection}>
            <div className="review-heading"><div><span className="eyebrow">03 / REVIEW & COMPARE</span><h2>See exactly what changed.</h2><p>{result.summary}</p></div><span className={`page-badge ${render?.ready ? "" : "blocked"}`}>{render ? render.ready ? "1 page · ready for review" : resume.format==="docx"?"DOCX draft · page count unverified":"PDF download blocked" : "Preview needed"}{render?.ready && <Check size={14} />}</span></div>
            {result.keywords.length > 0 && <div className="keywords"><span>Supported keywords</span>{result.keywords.map((word, index) => <span className="keyword" key={`${word}-${index}`}>{word}</span>)}</div>}
            {[...(result.notices ?? []), ...resume.warnings, ...(render?.warnings ?? [])].map((warning, index) => <div className="review-warning" key={index}>{warning}</div>)}
            <div className="review-navigation"><a href="#wording-changes">1. Review {visibleEdits.length} wording changes</a><a href="#layout-comparison">2. Check layout & download</a><span><del>Removed wording</del><ins>Added wording</ins></span></div>
            <div className="review-grid"><div className="edits-list" id="wording-changes"><div className="review-subheading"><h3>1. What changed, and why</h3><span>{visibleEdits.length} actual {visibleEdits.length === 1 ? "change" : "changes"} · unchanged text omitted</span></div>
              {visibleEdits.length === 0 && <p className="empty-edits">No factual, meaningful wording changes remain. Unchanged suggestions are not counted. Any unsafe suggestions blocked locally are listed above.</p>}
              {visibleEdits.map((edit, index) => {
                const paragraph = resume.paragraphs.find((paragraph) => paragraph.id === edit.id)!;
                return <article className="edit-card" key={edit.id}><div className="edit-label">CHANGE {index + 1}<button className="text-button" disabled={Boolean(busy)} onClick={() => { setEdits((current) => current.filter((item) => item.id !== edit.id)); setDirty(true); setReviewed(false); setApproved(false); }}>Reject · keep original</button></div><TextDiff before={paragraph.text} after={edit.text} /><div className="edit-reason"><strong>Why this change</strong><p>{edit.reason}</p></div>{paragraph.context && <details className="edit-context"><summary>Where this appears in your resume</summary><small>Original paragraph. Highlighted text is the portion changed above.</small><OriginalContext context={paragraph.context} text={paragraph.text} /></details>}<details className="edit-manually"><summary>Edit replacement text</summary><textarea aria-label={`Replacement for change ${index + 1}`} value={edit.text} maxLength={8000} disabled={Boolean(busy)} onChange={(event) => changeEdit(edit.id, event.target.value)} rows={4} /></details></article>;
              })}
              <button className="secondary-button" disabled={Boolean(busy) || !dirty} onClick={() => void refreshPreview()}>{busy === "render" ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />} Update preview with my edits</button>
            </div><div className="preview-column" id="layout-comparison"><div className="preview-toolbar"><h3>2. Check layout & download</h3><div className="preview-toggle">{(["compare", "original", "tailored"] as const).map((mode) => <button key={mode} className={preview === mode ? "selected" : ""} onClick={() => setPreview(mode)}>{mode === "compare" ? "Side by side" : mode === "original" ? "Original" : "Tailored"}</button>)}</div></div>
              <div className={`document-comparison ${preview === "compare" ? "side-by-side" : ""}`}>
                {preview !== "tailored" && <div><div className="document-label">ORIGINAL <span>Source of truth</span></div><DocumentPreview id={resume.id} format={resume.format} onStatus={setOriginalReady}/></div>}
                {preview !== "original" && <div><div className="document-label">TAILORED <span>{dirty ? "Out of date" : render?.ready ? "Review required" : resume.format==="docx"?"Draft only":"Not ready for download"}</span></div>{render ? <DocumentPreview id={resume.id} format={resume.format} tailored revision={render.revision} onStatus={setTailoredReady}/> : <div className="preview-placeholder">Update the preview to see your changes.</div>}</div>}
              </div>
              {dirty && <p className="review-warning">This preview is out of date. Update it before approving.</p>}
              <div className="approval"><input id="reviewed" type="checkbox" checked={reviewed} disabled={dirty || (!render?.ready&&resume.format!=="docx") || !originalReady || !tailoredReady || Boolean(busy)} onChange={(event) => { setReviewed(event.target.checked); setApproved(false); }} /><label htmlFor="reviewed">I checked the wording and both previews for layout and clipped text.{resume.format==="docx"?" I understand this is a draft; I must verify one page in Word/Pages before using it.":""}</label></div>
              {resume.format==="docx"?<button className="secondary-button" disabled={!reviewed||dirty||!originalReady||!tailoredReady||Boolean(busy)} onClick={()=>void download(false,true)}><ArrowDownToLine size={16}/> Download DOCX draft · not page-certified</button>:!approved ? <button className="primary-button" disabled={!reviewed || dirty || !render?.ready || !originalReady || !tailoredReady || Boolean(busy)} onClick={() => void approve()}><CheckCheck size={17} /> Approve this version</button> : <button className="primary-button" disabled={Boolean(busy)||dirty||!render?.ready} onClick={()=>void download()}><ArrowDownToLine size={16}/> Download one-page PDF</button>}
              <p className="field-hint">PDF stays PDF; DOCX stays DOCX. No cross-format reconstruction or legacy .doc conversion. All document processing runs on this device.</p>
            </div></div>
          </section>}
          <footer><span className="footer-brand">resumator.</span><a href="https://github.com/reyesrico/resumator" target="_blank" rel="noreferrer">Source code</a><a href="./AGPL-3.0.txt" target="_blank" rel="noreferrer">AGPL-3.0-or-later</a><span><LockKeyhole size={12} /> Your device. No backend.</span></footer>
        </main>
      </div>
    </div>
  );
}
