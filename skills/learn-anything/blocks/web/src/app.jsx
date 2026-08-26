import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import DOMPurify from "dompurify";
import { marked } from "marked";
import mermaid from "mermaid";
import {
  appendPartialDelta,
  createPartialMessage,
  mergeSnapshotMessages,
  upsertMessage,
} from "./message-state.mjs";
import { activeSurface, applyA2uiMessages, applyParameterFrame, resolveDataBinding, surfaceComponents } from "../../a2ui/state.mjs";
import { indentWithTab } from "./editor-input.mjs";
import { clearDraft, loadDraft, saveDraft } from "./draft-store.mjs";
import { connectionIssueFor, firstLearnerComponentId, resolveFocus, shouldReleaseRescue, workTaskKey } from "./workspace-state.mjs";

marked.setOptions({ gfm: true, breaks: true });
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    background: "#fbfaf7",
    primaryColor: "#f3f1ec",
    primaryTextColor: "#1b1a18",
    primaryBorderColor: "#c9c4bb",
    secondaryColor: "#e8eeff",
    secondaryTextColor: "#1b1a18",
    secondaryBorderColor: "#9aace8",
    tertiaryColor: "#ffffff",
    tertiaryTextColor: "#1b1a18",
    tertiaryBorderColor: "#c9c4bb",
    lineColor: "#8b867e",
    edgeLabelBackground: "#fbfaf7",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
  flowchart: { htmlLabels: false },
});

const fragment = new URLSearchParams(window.location.hash.slice(1));
const fragmentToken = fragment.get("token");
if (fragmentToken) {
  sessionStorage.setItem("learn-anything-token", fragmentToken);
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
const accessToken = fragmentToken || sessionStorage.getItem("learn-anything-token") || "";

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-learn-anything-token": accessToken,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("Learn Anything surface failed", error);
    if (this.props.root) document.body.dataset.crashed = "1";
  }

  componentDidMount() {
    if (this.props.root) delete document.body.dataset.crashed;
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.root) {
      return (
        <main className="root-fallback">
          <h1>Workspace needs to reload</h1>
          <p>The browser shell is still available. Use <strong>Ask mentor</strong> to reload and return to chat.</p>
        </main>
      );
    }
    return (
      <section className="activity-error">
        This activity could not render. Use Ask mentor and describe what you saw.
      </section>
    );
  }
}

function Markdown({ content, className = "" }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content || "")), [content]);
  return <div className={`message-markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function WorkspaceStatus({ connected, mentorAttached, degraded, hasRunnableCode }) {
  const notices = [...new Set((degraded || []).flatMap((item) => {
    if (item === "host-execution-full-user-permissions") return hasRunnableCode ? ["code has full local permissions"] : [];
    if (item === "mentor-output-may-arrive-per-turn" || item === "mentor-output-arrives-after-headless-turn") return ["turn-complete replies"];
    return [item.replaceAll("-", " ")];
  }))];
  return (
    <div className="workspace-status" title={notices.join(" · ")}>
      <span className={`status-dot ${connected && mentorAttached ? "is-connected" : "is-connecting"}`} />
      <span>{!connected ? "Connecting" : mentorAttached ? "Mentor ready" : "Mentor unavailable"}</span>
      {hasRunnableCode && <span className="status-detail">Local runner</span>}
    </div>
  );
}

function ContinuationBanner({ continuation }) {
  if (!continuation?.text) return null;
  return <section className={`course-continuation is-${continuation.kind || "action"}`}>
    <div className="anchored-note-label">{continuation.kind === "question" ? "Your turn" : "Next step"}</div>
    <Markdown content={continuation.text} />
  </section>;
}

function ChatComposer({ draft, setDraft, sending, sendError, mentorState, onSend, onInterrupt, inputRef, centered = false }) {
  return (
    <form onSubmit={(event) => { event.preventDefault(); void onSend(); }} className={`chat-composer ${centered ? "chat-composer-centered" : ""}`}>
      <div className="mentor-presence" role="status" aria-live="polite">
        {mentorState === "waiting" && <><span className="thinking-dot" />Thinking about your question… <button type="button" className="mentor-stop" onClick={onInterrupt}>Stop</button></>}
        {mentorState === "responding" && <><span className="thinking-dot" />Writing a response… <button type="button" className="mentor-stop" onClick={onInterrupt}>Stop</button></>}
      </div>
      <div className="composer-control">
        <textarea name="mentor-question" ref={inputRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void onSend(); } }} rows={centered ? 3 : 2} placeholder={centered ? "What would you like to understand, build, or practice?" : "Ask a follow-up or share what you tried…"} />
        <button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">{sending ? "Sending…" : "Send"}</button>
      </div>
      {centered && <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>}
      {sendError && <p className="send-error">Could not send: {sendError}</p>}
    </form>
  );
}

function ConnectionIssue({ issue }) {
  if (!issue) return null;
  return (
    <aside className="connection-issue" role="alert">
      <div className="connection-issue-mark">!</div>
      <div>
        <strong>{issue.title}</strong>
        <p>{issue.message}</p>
      </div>
    </aside>
  );
}

function Message({ message }) {
  const isUser = message.role === "user";
  return (
    <article className={`chat-message ${isUser ? "chat-message-user" : "chat-message-mentor"}`}>
      <div className="message-role">{isUser ? "You" : "Mentor"}</div>
      <Markdown content={message.content} />
    </article>
  );
}

function latestWorkExchange(messages) {
  let questionIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user" && messages[index]?.source === "work") {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return null;
  const question = messages[questionIndex];
  const answer = messages.slice(questionIndex + 1).find((message) => message?.role === "assistant") || null;
  return { question, answer };
}

function CodeEditor({ language, value, onChange, onSelect }) {
  const rows = Math.max(4, Math.min(18, value.split(/\r?\n/).length + 2));
  return <textarea name={`${language}-editor`} aria-label={`${language} editor`} rows={rows} className="code-fallback" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const input = event.currentTarget;
    const next = indentWithTab(input.value, input.selectionStart, input.selectionEnd);
    onChange(next.value);
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  }} onSelect={(event) => {
    const quote = event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd).trim();
    if (quote) onSelect?.(quote);
  }} />;
}

function DataTable({ columns = [], rows = [], caption }) {
  return (
    <figure className="data-surface overflow-hidden">
      {caption && <figcaption>{caption}</figcaption>}
      <div className="overflow-auto">
        <table>
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{columns.map((column, columnIndex) => <td key={`${rowIndex}-${column}`}>{Array.isArray(row) ? String(row[columnIndex] ?? "") : String(row?.[column] ?? "")}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </figure>
  );
}

function CodeBlock({ component, onContext }) {
  const draftKey = `code:${component._surfaceId || "surface"}:${component.id || "editor"}`;
  const [code, setCode] = useState(() => loadDraft(window.localStorage, draftKey, component.value || ""));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(component.lastResult || null);
  const saveTimer = useRef(null);
  const resultRef = useRef(null);

  function scheduleSave(value) {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!component.id) return;
      try {
        await api("/api/action", {
          method: "POST",
          body: JSON.stringify({ action: "code_change", componentId: component.id, code: value }),
        });
        clearDraft(window.localStorage, draftKey, value);
      } catch (error) {
        setResult({ error: `Could not save editor state: ${error.message}` });
      }
    }, 400);
  }

  useEffect(() => {
    const local = loadDraft(window.localStorage, draftKey, null);
    setCode(local ?? component.value ?? "");
    if (local !== null && local !== component.value) scheduleSave(local);
  }, [component.value, draftKey]);
  useEffect(() => setResult(component.lastResult || null), [component.lastResult]);
  useEffect(() => {
    if (result) requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }, [result]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  function updateCode(value) {
    setCode(value);
    saveDraft(window.localStorage, draftKey, value);
    scheduleSave(value);
  }

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const nextResult = await api("/api/run", {
        method: "POST",
        body: JSON.stringify({ componentId: component.id || null, language: component.language || "javascript", code }),
      });
      setResult(nextResult);
    } catch (error) {
      setResult({ error: error.message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="playground-surface overflow-hidden">
      <div className="surface-toolbar">
        <span>{component.language || "text"}</span>
        {component.runnable !== false && (
          <button onClick={run} disabled={running}>
            {running ? "Running…" : "Run"}
          </button>
        )}
      </div>
      <div className="editor-shell"><CodeEditor language={component.language || "javascript"} value={code} onChange={updateCode} onSelect={(quote) => onContext?.({ componentId: component.id, label: `${component.language || "code"} code`, quote })} /></div>
      {result && <div ref={resultRef} className="execution-result" aria-live="polite">
        {result.table?.columns?.length
          ? <DataTable columns={result.table.columns} rows={result.table.rows} caption={`Query result · ${result.table.rowCount} row${result.table.rowCount === 1 ? "" : "s"}`} />
          : <pre className={`console-output ${result.error || result.exitCode ? "text-red-300" : "text-slate-200"}`}>{result.error || result.stderr || result.stdout || "Completed."}</pre>}
        {!result.error && <div className="run-meta">{result.durationMs}ms{result.table?.truncatedRows ? " · first 500 rows" : ""}</div>}
      </div>}
    </section>
  );
}

function MermaidBlock({ source }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    mermaid.render(`diagram-${crypto.randomUUID()}`, source || "flowchart LR\nA[Empty]")
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((reason) => !cancelled && setError(reason.message));
    return () => { cancelled = true; };
  }, [source]);
  if (error) return <pre className="activity-error">{error}</pre>;
  return <div className="diagram-surface" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function PassageBlock({ component }) {
  return <figure className="passage-surface"><blockquote>{component.text}</blockquote>{component.source && <figcaption>{component.source}</figcaption>}{(component.annotations || []).map((annotation, index) => <aside key={annotation.id || index}><strong>{annotation.quote}</strong><span>{annotation.note}</span></aside>)}</figure>;
}

function FigureBlock({ component }) {
  return <figure className="figure-surface"><MermaidBlock source={component.mermaid || component.source} />{component.caption && <figcaption>{component.caption}</figcaption>}{(component.callouts || []).length > 0 && <ol>{component.callouts.map((callout, index) => <li key={callout.id || index}>{callout.label}</li>)}</ol>}</figure>;
}

function MathBlock({ component }) {
  const [rendered, setRendered] = useState({ html: "" });
  useEffect(() => {
    let cancelled = false;
    import("katex").then(({ renderToString }) => {
      const html = renderToString(component.expression || "", {
        displayMode: component.display !== false,
        output: "mathml",
        throwOnError: true,
        trust: false,
      });
      if (!cancelled) setRendered({ html: DOMPurify.sanitize(html, { USE_PROFILES: { mathMl: true } }) });
    }).catch((error) => !cancelled && setRendered({ error: error.message }));
    return () => { cancelled = true; };
  }, [component.expression, component.display]);
  if (rendered.error) return <section className="activity-error">This notation could not render: {rendered.error}</section>;
  return <figure className="math-surface" aria-busy={!rendered.html}><div dangerouslySetInnerHTML={{ __html: rendered.html }} />{component.caption && <figcaption>{component.caption}</figcaption>}</figure>;
}

const plotColors = ["var(--plot-1)", "var(--plot-2)", "var(--plot-3)", "var(--plot-4)", "var(--plot-5)", "var(--plot-6)", "var(--plot-7)", "var(--plot-8)"];
const plotDashes = ["", "8 5", "2 4", "12 4 2 4"];

function tickLabel(value) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

function PlotBlock({ component, onContext }) {
  const width = 760;
  const height = 390;
  const margin = { top: 24, right: 24, bottom: 58, left: 68 };
  const series = component.series || [];
  const points = series.flatMap((item) => item.points || []);
  const xValues = points.map((point) => point[0]);
  const yValues = points.map((point) => point[1]);
  const expand = (min, max) => min === max ? [min - 1, max + 1] : [min, max];
  const [xMin, xMax] = expand(component.x?.min ?? Math.min(...xValues), component.x?.max ?? Math.max(...xValues));
  const [yMin, yMax] = expand(component.y?.min ?? Math.min(...yValues), component.y?.max ?? Math.max(...yValues));
  const x = (value) => margin.left + ((value - xMin) / (xMax - xMin)) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - ((value - yMin) / (yMax - yMin)) * (height - margin.top - margin.bottom);
  const ticks = Array.from({ length: 5 }, (_, index) => index / 4);
  const describePoint = (item, point) => `${item.label || item.id || "Series"}: ${component.x?.label || "x"} ${tickLabel(point[0])}, ${component.y?.label || "y"} ${tickLabel(point[1])}`;
  return (
    <figure className="plot-surface">
      {component.title && <h3>{component.title}</h3>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${component.id}-plot-title ${component.id}-plot-desc`}>
        <title id={`${component.id}-plot-title`}>{component.title || "Interactive plot"}</title>
        <desc id={`${component.id}-plot-desc`}>{component.description || `${series.length} plotted series. A data table follows the chart.`}</desc>
        <g className="plot-grid">
          {ticks.map((ratio) => {
            const tickX = margin.left + ratio * (width - margin.left - margin.right);
            const tickY = margin.top + ratio * (height - margin.top - margin.bottom);
            return <React.Fragment key={ratio}><line x1={tickX} x2={tickX} y1={margin.top} y2={height - margin.bottom} /><line x1={margin.left} x2={width - margin.right} y1={tickY} y2={tickY} /></React.Fragment>;
          })}
        </g>
        <g className="plot-axes">
          <line x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} />
          <line x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} />
          {ticks.map((ratio) => <React.Fragment key={ratio}>
            <text x={margin.left + ratio * (width - margin.left - margin.right)} y={height - margin.bottom + 24} textAnchor="middle">{tickLabel(xMin + ratio * (xMax - xMin))}</text>
            <text x={margin.left - 12} y={height - margin.bottom - ratio * (height - margin.top - margin.bottom) + 4} textAnchor="end">{tickLabel(yMin + ratio * (yMax - yMin))}</text>
          </React.Fragment>)}
          {component.x?.label && <text className="axis-label" x={(margin.left + width - margin.right) / 2} y={height - 12} textAnchor="middle">{component.x.label}{component.x.unit ? ` (${component.x.unit})` : ""}</text>}
          {component.y?.label && <text className="axis-label" transform={`translate(17 ${(margin.top + height - margin.bottom) / 2}) rotate(-90)`} textAnchor="middle">{component.y.label}{component.y.unit ? ` (${component.y.unit})` : ""}</text>}
        </g>
        {series.map((item, seriesIndex) => {
          const color = plotColors[seriesIndex];
          const path = (item.points || []).map((point, pointIndex) => `${pointIndex ? "L" : "M"}${x(point[0])},${y(point[1])}`).join(" ");
          return <g key={item.id || seriesIndex} data-plot-series={item.id || seriesIndex}>
            <path d={path} fill="none" stroke={color} strokeWidth="3" strokeDasharray={plotDashes[seriesIndex % plotDashes.length]} />
            {(item.points || []).map((point, pointIndex) => {
              const label = describePoint(item, point);
              const ask = () => onContext?.({ componentId: component.id, label: component.title || "plot", quote: label });
              return <circle key={pointIndex} cx={x(point[0])} cy={y(point[1])} r="4.5" fill="var(--surface)" stroke={color} strokeWidth="2.5" aria-hidden="true" onClick={ask} />;
            })}
          </g>;
        })}
      </svg>
      <div className="plot-legend" aria-label="Plot legend">{series.map((item, index) => <span key={item.id || index}><i style={{ "--series-color": plotColors[index] }} />{item.label || item.id || `Series ${index + 1}`}</span>)}</div>
      <details className="plot-data"><summary>View plotted values</summary>{series.map((item, index) => <DataTable key={item.id || index} caption={item.label || item.id || `Series ${index + 1}`} columns={[component.x?.label || "x", component.y?.label || "y"]} rows={item.points} />)}</details>
      {component.caption && <figcaption>{component.caption}</figcaption>}
    </figure>
  );
}

function ParameterBlock({ component, onParameterChange }) {
  function change(control, value, persist = false) {
    onParameterChange?.(component.id, control.id, Number(value), persist);
  }
  return <section className="parameter-surface">{component.title && <h3>{component.title}</h3>}{(component.controls || []).map((control) => <label key={control.id}><span>{control.label}</span><output>{control.value}{control.unit ? ` ${control.unit}` : ""}</output><input name={control.id} aria-label={control.label} type="range" min={control.min} max={control.max} step={control.step || 1} value={control.value} onChange={(event) => change(control, event.currentTarget.value)} onPointerUp={(event) => change(control, event.currentTarget.value, true)} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) change(control, event.currentTarget.value, true); }} /></label>)}</section>;
}

function StageComponent({ component, onContext, onParameterChange }) {
  if (component.type === "markdown") return <article className="prose-surface"><Markdown content={component.content} /></article>;
  if (component.type === "callout") {
    const tone = component.tone === "success" ? "is-success" : component.tone === "warning" ? "is-warning" : "";
    return <section className={`callout-surface ${tone}`}><h3>{component.title}</h3><Markdown content={component.content} /></section>;
  }
  if (component.type === "code") return <CodeBlock component={component} onContext={onContext} />;
  if (component.type === "table") return <DataTable columns={component.columns} rows={component.rows} caption={component.caption} />;
  if (component.type === "passage") return <PassageBlock component={component} />;
  if (component.type === "figure") return <FigureBlock component={component} />;
  if (component.type === "math") return <MathBlock component={component} />;
  if (component.type === "plot") return <PlotBlock component={component} onContext={onContext} />;
  if (component.type === "params") return <ParameterBlock component={component} onParameterChange={onParameterChange} />;
  if (component.type === "mermaid") return <MermaidBlock source={component.source} />;
  if (component.type === "quiz") {
    return (
      <section className="interaction-list">
        <h3>{component.question}</h3>
        <div>
          {(component.options || []).map((option) => (
            <button key={option.id} onClick={() => api("/api/action", { method: "POST", body: JSON.stringify({ action: "quiz_answer", componentId: component.id, optionId: option.id }) })} className={component.selectedOptionId === option.id ? "is-selected" : ""}>{option.label}</button>
          ))}
        </div>
      </section>
    );
  }
  if (component.type === "checklist") {
    return (
      <section className="interaction-list checklist-list">
        <div>
          {(component.items || []).map((item) => (
            <label key={item.id}>
              <input name={item.id} type="checkbox" checked={Boolean(item.done)} onChange={() => api("/api/action", { method: "POST", body: JSON.stringify({ action: "checklist_toggle", componentId: component.id, itemId: item.id, done: !item.done }) })} />
              <span className={item.done ? "is-done" : ""}>{item.label}</span>
            </label>
          ))}
        </div>
      </section>
    );
  }
  return <pre className="unknown-surface">{JSON.stringify(component, null, 2)}</pre>;
}

function bindComponent(component, dataModel) {
  return Object.fromEntries(Object.entries(component).map(([key, value]) => [key, resolveDataBinding(value, dataModel)]));
}

function A2uiNode({ componentId, surface, onContext, onParameterChange, replyFor }) {
  const source = surface?.components?.[componentId];
  if (!source) return <section className="activity-error">Canvas component “{componentId}” is missing.</section>;
  const component = bindComponent(source, surface.dataModel || {});
  if (component.component === "Column" || component.component === "Row") {
    const children = Array.isArray(component.children) ? component.children : [];
    return <div className={`a2ui-${component.component.toLowerCase()}`}>{children.map((childId) => <A2uiNode key={childId} componentId={childId} surface={surface} onContext={onContext} onParameterChange={onParameterChange} replyFor={replyFor} />)}</div>;
  }
  const normalized = { ...component, _surfaceId: surface.id, type: String(component.component || "unknown").toLowerCase() };
  const label = component.title || component.question || String(component.component || "component").toLowerCase();
  const reply = replyFor(component.id);
  return (
    <div data-component-id={component.id || ""} onMouseUp={() => {
      const quote = window.getSelection()?.toString().trim();
      if (quote && component.id) onContext({ componentId: component.id, label, quote: quote.slice(0, 2000) });
    }} className="stage-component">
      <ErrorBoundary>
        <StageComponent component={normalized} onContext={onContext} onParameterChange={onParameterChange} />
      </ErrorBoundary>
      <button type="button" onClick={() => onContext({ componentId: component.id, label })} className="ask-component">Ask about this</button>
      {reply && <aside className="anchored-mentor-note">
        <div className="anchored-note-label">Mentor on this part</div>
        {reply.context?.quote && <blockquote>{reply.context.quote}</blockquote>}
        <Markdown content={reply.content} />
      </aside>}
    </div>
  );
}

function applyCanvasPayload(current, payload) {
  if (!payload) return current;
  if (!payload.messages?.length) return current ? { ...current, focus: payload.focus || current.focus } : current;
  const base = current?.surfaces ? current : { focus: "chat", activeSurfaceId: null, surfaces: {} };
  const next = applyA2uiMessages(base, payload.messages, { focus: payload.focus });
  if (payload.activeSurfaceId && next.surfaces[payload.activeSurfaceId]) next.activeSurfaceId = payload.activeSurfaceId;
  return next;
}

function App() {
  const [topic, setTopic] = useState("Learning workspace");
  const [messages, setMessages] = useState([]);
  const [canvas, setCanvas] = useState(null);
  const [continuation, setContinuation] = useState(null);
  const [degraded, setDegraded] = useState([]);
  const [connected, setConnected] = useState(false);
  const [mentorAttached, setMentorAttached] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState(null);
  const [chatDraft, setChatDraft] = useState(() => loadDraft(window.localStorage, "chat", ""));
  const [workDraft, setWorkDraft] = useState(() => loadDraft(window.localStorage, "work", ""));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [workContext, setWorkContext] = useState(null);
  const [mentorState, setMentorState] = useState("idle");
  const partial = useRef(new Map());
  const rescueQuestionPending = useRef(false);
  const rescueReplyCompleted = useRef(false);
  const canvasRef = useRef(null);
  const previousTaskKey = useRef("");
  const messageEndRef = useRef(null);
  const composerRef = useRef(null);
  const stageScrollRef = useRef(null);
  const previousFocus = useRef(null);

  const focus = resolveFocus(canvas);
  const surface = activeSurface(canvas);
  const components = surfaceComponents(canvas);
  const hasRunnableCode = components.some((component) => component?.component === "Code" && component.runnable !== false);
  const hasWorkSurface = Boolean(surface?.components?.root?.children?.length);
  const workExchange = latestWorkExchange(messages);
  const canvasTitle = surface?.dataModel?.title || topic;
  const canvasDirection = ["rtl", "auto"].includes(surface?.dataModel?.direction) ? surface.dataModel.direction : "ltr";
  const taskKey = workTaskKey(canvas);
  const taskInstructionId = firstLearnerComponentId(canvas);
  const latestMentorMessage = [...messages].reverse().find((message) => message?.role === "assistant") || null;
  const workMentorLead = latestMentorMessage
    && !latestMentorMessage.context?.componentId
    && latestMentorMessage.id !== workExchange?.answer?.id
    ? latestMentorMessage
    : null;

  function replyFor(componentId) {
    return [...messages].reverse().find((message) => message?.role === "assistant" && message?.source === "work" && message?.context?.componentId === componentId) || null;
  }

  function clearRescueState() {
    delete document.body.dataset.rescue;
    delete document.body.dataset.rescueSurface;
    rescueQuestionPending.current = false;
    rescueReplyCompleted.current = false;
  }

  function releaseRescueIfReady(candidateCanvas, replyCompleted = rescueReplyCompleted.current) {
    const rescuedSurfaceId = document.body.dataset.rescueSurface || "";
    if (document.body.dataset.rescue === "1" && shouldReleaseRescue(candidateCanvas, rescuedSurfaceId, replyCompleted)) {
      clearRescueState();
      return true;
    }
    return false;
  }

  useEffect(() => {
    canvasRef.current = canvas;
  }, [canvas]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    const changed = Boolean(taskKey && taskKey !== previousTaskKey.current);
    previousTaskKey.current = taskKey;
    if (focus === "work" && changed) requestAnimationFrame(() => {
      const instruction = [...(stageScrollRef.current?.querySelectorAll("[data-component-id]") || [])]
        .find((element) => element.dataset.componentId === taskInstructionId);
      instruction?.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, [focus, taskInstructionId, taskKey]);

  function focusWorkSurface() {
    const stage = stageScrollRef.current;
    const target = stage?.querySelector('.parameter-surface input:not([disabled]), .playground-surface textarea:not([disabled]), .playground-surface button:not([disabled]), .interaction-list button:not([disabled]), .checklist-list input:not([disabled]), .work-question-input:not([disabled]), .stage-pane button:not(.ask-component):not([disabled])');
    (target || stage)?.focus({ preventScroll: true });
  }

  useEffect(() => {
    const previous = previousFocus.current;
    previousFocus.current = focus;
    if (focus === "work" && previous && previous !== "work") requestAnimationFrame(focusWorkSurface);
  }, [focus, canvas?.activeSurfaceId]);

  useEffect(() => {
    document.body.dataset.focus = focus;
    document.body.dataset.surfaceId = canvas?.activeSurfaceId || "";
    document.body.dataset.hasWork = hasWorkSurface ? "1" : "";
    const returnedSurfaceId = document.body.dataset.returnWorkSurface || "";
    if (document.body.dataset.returnWork === "1" && (focus === "work" || (returnedSurfaceId && canvas?.activeSurfaceId !== returnedSurfaceId))) {
      delete document.body.dataset.returnWork;
      delete document.body.dataset.returnWorkSurface;
    }
    releaseRescueIfReady(canvas);
  }, [focus, canvas?.focus, canvas?.activeSurfaceId, hasWorkSurface]);

  useEffect(() => {
    const rescue = () => {
      rescueQuestionPending.current = false;
      rescueReplyCompleted.current = false;
      requestAnimationFrame(() => composerRef.current?.focus());
    };
    window.addEventListener("learn-anything:rescue-chat", rescue);
    return () => window.removeEventListener("learn-anything:rescue-chat", rescue);
  }, []);

  useEffect(() => {
    const returnToWork = () => {
      requestAnimationFrame(focusWorkSurface);
    };
    window.addEventListener("learn-anything:return-work", returnToWork);
    return () => window.removeEventListener("learn-anything:return-work", returnToWork);
  }, []);

  useEffect(() => {
    let source = null;
    let cancelled = false;
    let lossTimer = null;


    async function diagnoseLoss() {
      try {
        await api("/api/session");
      } catch (error) {
        if (!cancelled) setConnectionIssue(connectionIssueFor(error));
      }
    }

    async function connect() {
      try {
        await api("/api/session");
      } catch (error) {
        if (!cancelled) setConnectionIssue(connectionIssueFor(error));
        return;
      }
      if (cancelled) return;
      source = new EventSource(`/api/events?token=${encodeURIComponent(accessToken)}`);
      source.onopen = () => {
        clearTimeout(lossTimer);
        setConnected(true);
        setConnectionIssue(null);
      };
      source.onerror = () => {
        setConnected(false);
        clearTimeout(lossTimer);
        lossTimer = setTimeout(() => void diagnoseLoss(), 10_000);
      };
      source.onmessage = ({ data }) => {
      let event;
      try {
        event = JSON.parse(data);
      } catch (error) {
        console.error("Ignored malformed workspace event", error);
        return;
      }
      if (event.type === "STATE_SNAPSHOT") {
        setTopic(event.snapshot.topic || "Learning workspace");
        setMessages(mergeSnapshotMessages(event.snapshot.transcript, partial.current));
        setCanvas((current) => {
          const next = applyCanvasPayload(current, event.snapshot.canvas);
          canvasRef.current = next;
          return next;
        });
        setContinuation(event.snapshot.continuation || null);
        setDegraded(event.snapshot.assembly?.degraded || []);
        setMentorState(event.snapshot.mentorState || "idle");
        setMentorAttached(Boolean(event.snapshot.mentorAttached));
      } else if (event.type === "TEXT_MESSAGE_START") {
        const pendingMessage = createPartialMessage(event);
        partial.current.set(event.messageId, pendingMessage);
        setMessages((current) => upsertMessage(current, pendingMessage));
        if (pendingMessage.role === "assistant") setMentorState("responding");
      } else if (event.type === "TEXT_MESSAGE_CONTENT") {
        const pending = appendPartialDelta(partial.current, event);
        setMessages((current) => upsertMessage(current, pending));
        if (pending.role === "assistant") setMentorState("responding");
      } else if (event.type === "TEXT_MESSAGE_END") {
        const finished = partial.current.get(event.messageId);
        partial.current.delete(event.messageId);
        if (finished?.role === "assistant") {
          setMentorState("idle");
          if (rescueQuestionPending.current) {
            rescueReplyCompleted.current = true;
            releaseRescueIfReady(canvasRef.current, true);
          }
        }
      } else if (event.type === "CUSTOM" && event.name === "a2ui") {
        if (event.value?.continuation) setContinuation(event.value.continuation);
        setCanvas((current) => {
          const next = applyCanvasPayload(current, event.value);
          canvasRef.current = next;
          releaseRescueIfReady(next);
          return next;
        });
      } else if (event.type === "CUSTOM" && event.name === "mentor_presence") {
        setMentorAttached(Boolean(event.value?.attached));
      } else if (event.type === "CUSTOM" && event.name === "mentor_state") {
        setMentorState(event.value?.state || "idle");
      }
      };
    }
    void connect();
    return () => {
      cancelled = true;
      clearTimeout(lossTimer);
      source?.close();
    };
  }, []);

  function updateComposerDraft(source, value) {
    if (source === "work") setWorkDraft(value);
    else setChatDraft(value);
    saveDraft(window.localStorage, source, value);
  }

  async function sendMessage(source = "chat") {
    const currentDraft = source === "work" ? workDraft : chatDraft;
    const text = currentDraft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError("");
    try {
      await api("/api/message", {
        method: "POST",
        body: JSON.stringify({
          text,
          source,
          surfaceId: source === "work" ? canvas?.activeSurfaceId || null : null,
          context: source === "work" ? workContext : null,
        }),
      });
      clearDraft(window.localStorage, source, currentDraft);
      if (source === "work") {
        setWorkDraft("");
        setWorkContext(null);
      } else {
        setChatDraft("");
        if (document.body.dataset.rescue === "1") {
          rescueQuestionPending.current = true;
          rescueReplyCompleted.current = false;
        }
      }
      setMentorState("waiting");
    } catch (error) {
      const issue = connectionIssueFor(error);
      setSendError(issue.title === "Workspace stopped" ? "" : error.message);
      setConnected(false);
      setMentorAttached(false);
      setMentorState("idle");
      setConnectionIssue(issue);
    } finally {
      setSending(false);
    }
  }

  async function interruptMentor() {
    try {
      await api("/api/interrupt", { method: "POST", body: "{}" });
      setMentorState("idle");
    } catch (error) {
      setSendError(error.message);
    }
  }

  function updateParameter(componentId, controlId, value, persist = false) {
    setCanvas((current) => applyParameterFrame(current, componentId, controlId, value) || current);
    if (persist) {
      api("/api/action", {
        method: "POST",
        body: JSON.stringify({ action: "parameter_change", componentId, controlId, value }),
      }).catch((error) => setSendError(`Could not save this control: ${error.message}`));
    }
  }

  const emptyConversation = messages.length === 0;

  return (
    <main className="workspace" data-focus={focus}>
      <ConnectionIssue issue={connectionIssue} />
      <section className={`mentor-pane ${emptyConversation ? "is-empty" : "has-conversation"}`}>
        <header className="app-header">
          <div className="brand-lockup"><span className="brand-mark">L</span><span>Learn anything</span></div>
          {!emptyConversation && <h1>{topic}</h1>}
          <WorkspaceStatus connected={connected} mentorAttached={mentorAttached} degraded={degraded} hasRunnableCode={hasRunnableCode} />
        </header>
        {emptyConversation ? (
          <div className="welcome-shell">
            <div className="welcome-copy">
              <span className="welcome-kicker">Your private learning space</span>
              <h1>{topic}</h1>
              <p>Start anywhere. Ask a basic question, name something confusing, or describe what you want to make. The lesson will adapt as you go.</p>
            </div>
            <ChatComposer draft={chatDraft} setDraft={(value) => updateComposerDraft("chat", value)} sending={sending} sendError={sendError} mentorState={mentorState} onSend={() => sendMessage("chat")} onInterrupt={interruptMentor} inputRef={composerRef} centered />
          </div>
        ) : (
          <>
            <div className="chat-stream scroll-region">
              {messages.map((message) => <Message key={message.id} message={message} />)}
              <div ref={messageEndRef} />
            </div>
            <ContinuationBanner continuation={continuation?.kind === "question" ? continuation : null} />
            <ChatComposer draft={chatDraft} setDraft={(value) => updateComposerDraft("chat", value)} sending={sending} sendError={sendError} mentorState={mentorState} onSend={() => sendMessage("chat")} onInterrupt={interruptMentor} inputRef={composerRef} />
          </>
        )}
      </section>

      <section className="stage-pane" dir={canvasDirection} aria-label="Agent-generated learning canvas">
        <header className="stage-header">
          <div><span className="stage-topic">{topic}</span><h2 id="stage-title">{canvasTitle}</h2></div>
          <WorkspaceStatus connected={connected} mentorAttached={mentorAttached} degraded={degraded} hasRunnableCode={hasRunnableCode} />
        </header>
        <div ref={stageScrollRef} className="stage-scroll scroll-region" tabIndex="-1" aria-labelledby="stage-title">
          <div className="stage-column">
            {workMentorLead && <section className="work-mentor-lead">
              <div className="anchored-note-label">Mentor</div>
              <Markdown content={workMentorLead.content} />
            </section>}
            {surface?.components?.root
              ? <A2uiNode componentId="root" surface={surface} onContext={setWorkContext} onParameterChange={updateParameter} replyFor={replyFor} />
              : null}
            {workExchange && !workExchange.answer?.context?.componentId && <section className="work-mentor-reply">
              <div className="anchored-note-label">Your question</div>
              <Markdown content={workExchange.question.content} />
              <div className="anchored-note-label">Mentor</div>
              {workExchange.answer ? <Markdown content={workExchange.answer.content} /> : <p>{mentorState === "responding" ? "Responding…" : "Waiting…"}</p>}
            </section>}
          </div>
        </div>
        <form aria-label="Ask mentor from work" onSubmit={(event) => { event.preventDefault(); void sendMessage("work"); }} className="work-question-bar">
          <div className="work-question-inner">
            <ContinuationBanner continuation={continuation?.kind === "action" ? continuation : null} />
            <div className="mentor-presence" aria-live="polite">
              {mentorState === "waiting" && <><span className="thinking-dot" />Thinking about this… <button type="button" className="mentor-stop" onClick={interruptMentor}>Stop</button></>}
              {mentorState === "responding" && <><span className="thinking-dot" />Adding guidance… <button type="button" className="mentor-stop" onClick={interruptMentor}>Stop</button></>}
            </div>
            <div className="work-question-control">
              <textarea name="work-question" value={workDraft} onChange={(event) => updateComposerDraft("work", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage("work"); } }} rows="1" aria-label="Question about this activity" placeholder="Ask about this activity…" className="work-question-input" />
              <button type="submit" disabled={!workDraft.trim() || sending}>Ask</button>
            </div>
            {workContext && <div className="context-chip">
              <span>About {workContext.label}{workContext.quote ? `: “${workContext.quote.slice(0, 80)}${workContext.quote.length > 80 ? "…" : ""}”` : ""}</span>
              <button type="button" onClick={() => setWorkContext(null)}>Clear</button>
            </div>}
            {sendError && <p className="send-error">Could not send: {sendError}</p>}
          </div>
        </form>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<ErrorBoundary root><App /></ErrorBoundary>);
