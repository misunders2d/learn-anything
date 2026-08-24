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
import { activeSurface, applyA2uiMessages, resolveDataBinding, surfaceComponents } from "../../a2ui/state.mjs";
import { indentWithTab } from "./editor-input.mjs";
import { clearDraft, loadDraft, saveDraft } from "./draft-store.mjs";
import { connectionIssueFor, resolveFocus, shouldReleaseRescue } from "./workspace-state.mjs";

marked.setOptions({ gfm: true, breaks: true });
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", flowchart: { htmlLabels: false } });

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
        if (!cancelled) setSvg(DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true } }));
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

function ParameterBlock({ component }) {
  const [values, setValues] = useState(() => Object.fromEntries((component.controls || []).map((control) => [control.id, control.value])));
  function submit(control, value) {
    api("/api/action", { method: "POST", body: JSON.stringify({ action: "parameter_change", componentId: component.id, controlId: control.id, value: Number(value) }) }).catch(() => {});
  }
  return <section className="parameter-surface">{component.title && <h3>{component.title}</h3>}{(component.controls || []).map((control) => <label key={control.id}><span>{control.label}</span><output>{values[control.id]}</output><input name={control.id} type="range" min={control.min} max={control.max} step={control.step || 1} value={values[control.id]} onChange={(event) => setValues((current) => ({ ...current, [control.id]: Number(event.target.value) }))} onMouseUp={(event) => submit(control, event.currentTarget.value)} onTouchEnd={(event) => submit(control, event.currentTarget.value)} onKeyUp={(event) => submit(control, event.currentTarget.value)} /></label>)}</section>;
}

function StageComponent({ component, onContext }) {
  if (component.type === "markdown") return <article className="prose-surface"><Markdown content={component.content} /></article>;
  if (component.type === "callout") {
    const tone = component.tone === "success" ? "is-success" : component.tone === "warning" ? "is-warning" : "";
    return <section className={`callout-surface ${tone}`}><h3>{component.title}</h3><Markdown content={component.content} /></section>;
  }
  if (component.type === "code") return <CodeBlock component={component} onContext={onContext} />;
  if (component.type === "table") return <DataTable columns={component.columns} rows={component.rows} caption={component.caption} />;
  if (component.type === "passage") return <PassageBlock component={component} />;
  if (component.type === "figure") return <FigureBlock component={component} />;
  if (component.type === "params") return <ParameterBlock component={component} />;
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

function A2uiNode({ componentId, surface, onContext, replyFor }) {
  const source = surface?.components?.[componentId];
  if (!source) return <section className="activity-error">Canvas component “{componentId}” is missing.</section>;
  const component = bindComponent(source, surface.dataModel || {});
  if (component.component === "Column" || component.component === "Row") {
    const children = Array.isArray(component.children) ? component.children : [];
    return <div className={`a2ui-${component.component.toLowerCase()}`}>{children.map((childId) => <A2uiNode key={childId} componentId={childId} surface={surface} onContext={onContext} replyFor={replyFor} />)}</div>;
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
        <StageComponent component={normalized} onContext={onContext} />
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
  const messageEndRef = useRef(null);
  const composerRef = useRef(null);

  const focus = resolveFocus(canvas);
  const surface = activeSurface(canvas);
  const components = surfaceComponents(canvas);
  const hasRunnableCode = components.some((component) => component?.component === "Code" && component.runnable !== false);
  const workExchange = latestWorkExchange(messages);
  const canvasTitle = surface?.dataModel?.title || topic;

  function replyFor(componentId) {
    return [...messages].reverse().find((message) => message?.role === "assistant" && message?.source === "work" && message?.context?.componentId === componentId) || null;
  }

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    document.body.dataset.focus = focus;
    document.body.dataset.surfaceId = canvas?.activeSurfaceId || "";
    const rescuedSurfaceId = document.body.dataset.rescueSurface || "";
    if (document.body.dataset.rescue === "1" && shouldReleaseRescue(canvas, rescuedSurfaceId)) {
      delete document.body.dataset.rescue;
      delete document.body.dataset.rescueSurface;
    }
  }, [focus, canvas?.focus, canvas?.activeSurfaceId]);

  useEffect(() => {
    const rescue = () => requestAnimationFrame(() => composerRef.current?.focus());
    window.addEventListener("learn-anything:rescue-chat", rescue);
    return () => window.removeEventListener("learn-anything:rescue-chat", rescue);
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
        setCanvas((current) => applyCanvasPayload(current, event.snapshot.canvas));
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
        if (finished?.role === "assistant") setMentorState("idle");
      } else if (event.type === "CUSTOM" && event.name === "a2ui") {
        setCanvas((current) => applyCanvasPayload(current, event.value));
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
      } else setChatDraft("");
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
            <ChatComposer draft={chatDraft} setDraft={(value) => updateComposerDraft("chat", value)} sending={sending} sendError={sendError} mentorState={mentorState} onSend={() => sendMessage("chat")} onInterrupt={interruptMentor} inputRef={composerRef} />
          </>
        )}
      </section>

      <section className="stage-pane" aria-label="Agent-generated learning canvas">
        <header className="stage-header">
          <div><span className="stage-topic">{topic}</span><h2>{canvasTitle}</h2></div>
          <WorkspaceStatus connected={connected} mentorAttached={mentorAttached} degraded={degraded} hasRunnableCode={hasRunnableCode} />
        </header>
        <div className="stage-scroll scroll-region">
          <div className="stage-column">
            {surface?.components?.root
              ? <A2uiNode componentId="root" surface={surface} onContext={setWorkContext} replyFor={replyFor} />
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
