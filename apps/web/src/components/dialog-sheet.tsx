import { isDialogRequest, stripAnsi, type ExtensionUiRequest } from "@pios/protocol";
import { useState } from "react";
import { ListRowButton, ModalCard, PickerHeader } from "./ui.tsx";

export interface DialogAnswer {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/**
 * The agent is blocked on an extension's question until this is answered.
 *
 * Deliberately generic: PiOS renders whatever `method` pi sends and returns
 * the answer verbatim. It decides nothing and remembers nothing, so this is a
 * transport surface, not a permission policy.
 */
export function DialogSheet({ request, onAnswer }: {
  request: ExtensionUiRequest;
  onAnswer: (answer: DialogAnswer) => void;
}) {
  const [text, setText] = useState(request.prefill ?? "");
  const cancel = () => onAnswer({ cancelled: true });
  const title = stripAnsi(request.title ?? "The agent is asking");
  // A method with no renderer would be an unanswerable card, which is worse
  // than declining it: the agent stays blocked either way.
  const answerable = isDialogRequest(request);

  return (
    <ModalCard
      className="dialog"
      onSubmit={
        request.method === "input" || request.method === "editor"
          ? (event) => {
              event.preventDefault();
              onAnswer({ value: text });
            }
          : undefined
      }
    >
      <PickerHeader title={title} onCancel={cancel} />

      {answerable ? null : (
        <>
          <p className="muted">This request cannot be shown here.</p>
          <div className="row">
            <button type="button" onClick={cancel}>
              Dismiss
            </button>
          </div>
        </>
      )}

      {request.method === "confirm" ? (
        <>
          {request.message ? <p className="muted">{stripAnsi(request.message)}</p> : null}
          <div className="row">
            <button type="button" onClick={() => onAnswer({ confirmed: false })}>
              Deny
            </button>
            <button type="button" className="primary" onClick={() => onAnswer({ confirmed: true })}>
              Allow
            </button>
          </div>
        </>
      ) : null}

      {request.method === "select" ? (
        <div className="scroll-y">
          {(request.options ?? []).map((option, index) => (
            // Displayed without styling, answered with the original string:
            // the extension compares against exactly what it sent.
            <ListRowButton key={`${index}:${option}`} onClick={() => onAnswer({ value: option })}>
              <span className="line">{stripAnsi(option)}</span>
            </ListRowButton>
          ))}
        </div>
      ) : null}

      {request.method === "input" ? (
        <div className="field">
          <input
            autoFocus
            value={text}
            placeholder={request.placeholder ?? ""}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      ) : null}

      {request.method === "editor" ? (
        <div className="field">
          <textarea autoFocus rows={8} value={text} onChange={(event) => setText(event.target.value)} />
        </div>
      ) : null}

      {request.method === "input" || request.method === "editor" ? (
        <div className="row">
          <button type="submit" className="primary">
            Send
          </button>
        </div>
      ) : null}
    </ModalCard>
  );
}
