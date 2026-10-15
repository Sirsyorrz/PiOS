import { indentWithTab, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { defaultKeymap, indentLess, indentMore } from "@codemirror/commands";
import { HighlightStyle, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

/**
 * The CodeMirror half of the file view, imported lazily.
 *
 * Nothing above this module knows CodeMirror exists: the chat path is the hot
 * path, and an editor nobody opened must not be in its bundle.
 */

export interface EditorHandle {
  undo(): void;
  redo(): void;
  indent(): void;
  outdent(): void;
}

export function CodeEditor({ text, path, readOnly, wrap, handle, onChange }: {
  text: string;
  wrap: boolean;
  /** Only its extension is used, to pick a language. */
  path: string;
  readOnly: boolean;
  /** Filled in with the commands the accessory row drives. */
  handle: { current: EditorHandle | null };
  onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  // Its own compartment so toggling it keeps the history and the cursor.
  const wrapping = useRef(new Compartment());
  // Kept in a ref so changing the callback never rebuilds the editor, which
  // would drop the undo history and the cursor with it.
  const emit = useRef(onChange);
  emit.current = onChange;

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        history(),
        // Nothing is being edited in read-only mode, so nothing is active.
        ...(readOnly ? [] : [highlightActiveLine()]),
        wrapping.current.of(wrap ? EditorView.lineWrapping : []),
        indentUnit.of("  "),
        syntaxHighlighting(darkHighlight),
        theme,
        language.current.of([]),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorState.readOnly.of(readOnly),
        // A read-only file should not raise the software keyboard at all.
        EditorView.editable.of(!readOnly),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit.current(update.state.doc.toString());
        }),
      ],
    });

    const instance = new EditorView({ state, parent });
    view.current = instance;
    handle.current = {
      undo: () => undo(instance),
      redo: () => redo(instance),
      indent: () => indentMore(instance),
      outdent: () => indentLess(instance),
    };

    let live = true;
    void languageFor(path).then((support) => {
      if (live && support) instance.dispatch({ effects: language.current.reconfigure(support) });
    });

    return () => {
      live = false;
      handle.current = null;
      view.current = null;
      instance.destroy();
    };
    // `text` is the initial document only; later edits come from the editor.
  }, [path, readOnly]);

  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  // A reload after a conflict replaces the document wholesale.
  useEffect(() => {
    const instance = view.current;
    if (!instance || instance.state.doc.toString() === text) return;
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: text },
    });
  }, [text]);

  return <div className="code-editor" ref={host} />;
}

const theme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "var(--text)", height: "100%" },
    ".cm-content": { fontFamily: "var(--mono, ui-monospace, monospace)", padding: "8px 0 40vh" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--muted)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--hover)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "#31506e" },
    ".cm-scroller": { overflow: "auto", lineHeight: "1.5" },
  },
  { dark: true },
);

const darkHighlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "#c9a0e8" },
  { tag: [tags.string, tags.special(tags.string)], color: "#9ccf8e" },
  { tag: [tags.number, tags.bool, tags.null], color: "#e0a45e" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#8bb8e8" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "#7fc9c0" },
  { tag: [tags.propertyName, tags.attributeName], color: "#d6d6cf" },
  { tag: [tags.heading], color: "#8bb8e8", fontWeight: "bold" },
  { tag: [tags.link, tags.url], color: "var(--link)" },
  { tag: [tags.invalid], color: "var(--error)" },
]);

/**
 * Language per extension, each its own chunk.
 *
 * A fixed set: every extra grammar is weight that a phone downloads for a file
 * it will probably never open, and plain text is a perfectly good fallback.
 */
async function languageFor(path: string): Promise<Extension | null> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: true,
      });
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "jsx" });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "md":
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "html":
    case "htm":
      return (await import("@codemirror/lang-html")).html();
    case "py":
      return (await import("@codemirror/lang-python")).python();
    case "rs":
      return (await import("@codemirror/lang-rust")).rust();
    case "go":
      return (await import("@codemirror/lang-go")).go();
    case "yaml":
    case "yml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "sh":
    case "bash":
    case "zsh":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell);
    case "toml":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    default:
      return null;
  }
}
