import type { ImageContent, StreamingBehavior } from "@pios/protocol";
import { useEffect, useState } from "react";
import { browserStorage } from "../storage.ts";
import { ImageIcon, SendIcon, StopIcon } from "./icons.tsx";

const DRAFT_PREFIX = "pios.draft.";

/**
 * Composes a prompt and hands it to the outbox.
 *
 * The draft is saved per session on every keystroke, because the tab can be
 * evicted at any moment on a phone, and never touches the socket: sending
 * means queueing.
 */
export function Composer({ sessionId, running, interrupting, onSend, onInterrupt }: {
  sessionId: string;
  running: boolean;
  /** Stop was sent and the agent has not stopped yet. */
  interrupting: boolean;
  onSend: (text: string, images: ImageContent[], behavior?: StreamingBehavior) => void;
  onInterrupt: () => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageContent[]>([]);
  const [behavior, setBehavior] = useState<StreamingBehavior>("steer");

  useEffect(() => {
    setText(browserStorage.get(DRAFT_PREFIX + sessionId) ?? "");
    setImages([]);
  }, [sessionId]);

  function edit(value: string) {
    setText(value);
    browserStorage.set(DRAFT_PREFIX + sessionId, value);
  }

  function send() {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    // Mandatory while the agent streams, ignored otherwise; sending it always
    // is simpler than tracking who won the race with `agent_settled`.
    onSend(trimmed, images, running ? behavior : undefined);
    setText("");
    setImages([]);
    browserStorage.remove(DRAFT_PREFIX + sessionId);
  }

  async function attach(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      const data = await readBase64(file);
      setImages((current) => [...current, { type: "image", data, mimeType: file.type }]);
    }
  }

  return (
    <div className="composer">
      {images.length > 0 ? (
        <div className="attachments">
          {images.map((image, index) => (
            <img
              key={index}
              alt="attachment"
              src={`data:${image.mimeType};base64,${image.data}`}
              onClick={() => setImages(images.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      ) : null}

      <textarea
        value={text}
        rows={3}
        placeholder="Message pi"
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />

      <div className="composer-actions">
        <label className="attach ghost icon" title="Attach an image">
          <input type="file" accept="image/*" multiple onChange={(e) => void attach(e.target.files)} />
          <ImageIcon />
        </label>

        {running ? (
          <select
            className="ghost"
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as StreamingBehavior)}
          >
            <option value="steer">Steer now</option>
            <option value="followUp">Follow up after</option>
          </select>
        ) : null}

        <span className="spacer" />

        {/* Stop sits beside Send, not instead of it: queueing the next turn
            while the agent runs is the point of the steering selector. */}
        {running ? (
          <button
            type="button"
            className="icon ghost stop"
            disabled={interrupting}
            aria-label={interrupting ? "stopping" : "stop"}
            onClick={onInterrupt}
          >
            <StopIcon />
          </button>
        ) : null}
        <button
          type="button"
          className="icon send"
          aria-label="send"
          disabled={!text.trim() && images.length === 0}
          onClick={send}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}
