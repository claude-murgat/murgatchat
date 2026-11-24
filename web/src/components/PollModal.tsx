import { useRef, useState } from "react";
import { api } from "../api.ts";
import type { Message } from "../types.ts";
import { useOverlayDismiss } from "../hooks/useOverlayDismiss.ts";
import {
  POLL_OPTION_MAX,
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_QUESTION_MAX,
  pollErrorText,
  sameOption,
} from "../polls.ts";

interface PollModalProps {
  channelId: string;
  /** Nom du salon, rappelé sous le titre. */
  channelName: string | null;
  onClose: () => void;
  /** Le message du sondage publié (il arrive aussi par `message:new`). */
  onCreated?: (message: Message) => void;
}

// Création d'un sondage : la question, les réponses (2 à 20), le choix unique
// ou multiple, et si les membres peuvent proposer d'autres réponses.
export default function PollModal({ channelId, channelName, onClose, onCreated }: PollModalProps) {
  const [question, setQuestion] = useState("");
  // Chaque champ garde son identifiant : retirer la 2e réponse ne fait pas
  // glisser le texte ou le focus des suivantes.
  const nextId = useRef(2);
  const [options, setOptions] = useState([
    { id: 0, text: "" },
    { id: 1, text: "" },
  ]);
  const [multiple, setMultiple] = useState(false);
  const [allowAddOptions, setAllowAddOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const optionRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Champ ajouté qui doit prendre le focus. Il le prend dans son `ref`, donc au
  // moment même où il est inséré : un `setTimeout` arrivait après les touches
  // déjà tapées, et le début du texte partait dans la réponse précédente.
  const focusId = useRef<number | null>(null);
  const overlayDismiss = useOverlayDismiss(onClose);

  const filled = options.map((o) => o.text.trim()).filter(Boolean);
  // Index des réponses qui en répètent une précédente (signalées en rouge).
  const duplicates = new Set(
    options
      .map((o, i) =>
        o.text.trim() && options.slice(0, i).some((p) => p.text.trim() && sameOption(p.text, o.text))
          ? i
          : -1
      )
      .filter((i) => i >= 0)
  );
  const ready = !!question.trim() && filled.length >= POLL_OPTIONS_MIN && duplicates.size === 0;

  function setOption(i: number, text: string) {
    setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, text } : o)));
  }

  function addOption() {
    if (options.length >= POLL_OPTIONS_MAX) return;
    const id = nextId.current++;
    focusId.current = id;
    setOptions((prev) => [...prev, { id, text: "" }]);
  }

  function removeOption(i: number) {
    setOptions((prev) => prev.filter((_, j) => j !== i));
  }

  async function submit() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createPoll({
        channelId,
        question: question.trim(),
        options: filled,
        multiple,
        allowAddOptions,
      });
      onCreated?.(res.message);
      onClose();
    } catch (err) {
      setError(pollErrorText(err, "Le sondage n'a pas pu être publié. Réessayez."));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 grid place-items-stretch sm:place-items-center z-50 p-0 sm:p-4"
      {...overlayDismiss}
    >
      <div
        role="dialog"
        aria-label="Créer un sondage"
        onClick={(e) => e.stopPropagation()}
        className="bg-white text-slate-900 sm:rounded-xl shadow-2xl w-full h-dvh sm:h-auto sm:max-w-lg sm:max-h-[90vh] flex flex-col"
      >
        <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold">Créer un sondage</h2>
            {channelName && <div className="text-sm text-slate-500 truncate"># {channelName}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-800 w-8 h-8 shrink-0"
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>

        <form
          className="flex flex-col flex-1 min-h-0"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="p-5 space-y-5 overflow-y-auto flex-1">
            <label className="block">
              <span className="font-semibold text-sm">Question</span>
              <textarea
                autoFocus
                rows={2}
                className="mt-1 w-full border rounded-md px-3 py-2 resize-none"
                placeholder="ex. On se retrouve où pour le déjeuner d'équipe ?"
                value={question}
                maxLength={POLL_QUESTION_MAX}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  // Entrée passe aux réponses (Maj+Entrée : retour à la ligne).
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    optionRefs.current[0]?.focus();
                  }
                }}
              />
            </label>

            <fieldset>
              <legend className="font-semibold text-sm">Réponses</legend>
              <ol className="mt-1 space-y-2">
                {options.map(({ id, text: value }, i) => (
                  <li key={id} className="flex items-center gap-2">
                    <input
                      ref={(el) => {
                        optionRefs.current[i] = el;
                        if (el && focusId.current === id) {
                          focusId.current = null;
                          el.focus();
                        }
                      }}
                      aria-label={`Réponse ${i + 1}`}
                      className={`flex-1 min-w-0 border rounded-md px-3 py-2 ${
                        duplicates.has(i) ? "border-red-400 bg-red-50" : ""
                      }`}
                      placeholder={`Réponse ${i + 1}`}
                      value={value}
                      maxLength={POLL_OPTION_MAX}
                      onChange={(e) => setOption(i, e.target.value)}
                      onKeyDown={(e) => {
                        // Entrée : réponse suivante, ou nouvelle réponse depuis la dernière.
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        if (i < options.length - 1) optionRefs.current[i + 1]?.focus();
                        else if (value.trim()) addOption();
                      }}
                    />
                    {options.length > POLL_OPTIONS_MIN && (
                      <button
                        type="button"
                        onClick={() => removeOption(i)}
                        className="text-slate-400 hover:text-red-600 w-8 h-8 shrink-0"
                        aria-label={`Retirer la réponse ${i + 1}`}
                        title="Retirer cette réponse"
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ol>
              {duplicates.size > 0 && (
                <p className="mt-1 text-xs text-red-600">Deux réponses sont identiques.</p>
              )}
              {options.length < POLL_OPTIONS_MAX ? (
                <button
                  type="button"
                  onClick={() => addOption()}
                  className="mt-2 text-sm text-aubergine-700 hover:underline"
                >
                  + Ajouter une réponse
                </button>
              ) : (
                <p className="mt-2 text-xs text-slate-500">{POLL_OPTIONS_MAX} réponses au plus.</p>
              )}
            </fieldset>

            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-aubergine-700"
                  checked={multiple}
                  onChange={(e) => setMultiple(e.target.checked)}
                />
                <span>
                  <span className="font-medium text-sm">Plusieurs réponses possibles</span>
                  <span className="block text-xs text-slate-500">
                    Sinon, chacun choisit une seule réponse.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-1 accent-aubergine-700"
                  checked={allowAddOptions}
                  onChange={(e) => setAllowAddOptions(e.target.checked)}
                />
                <span>
                  <span className="font-medium text-sm">Les membres peuvent ajouter des réponses</span>
                  <span className="block text-xs text-slate-500">
                    Sinon, vous seul pourrez en ajouter après la publication.
                  </span>
                </span>
              </label>
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            )}
          </div>
          <div className="p-4 border-t border-slate-200 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md text-slate-700 hover:bg-slate-100"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={!ready || busy}
              className="px-4 py-2 rounded-md bg-aubergine-700 text-white font-medium hover:bg-aubergine-800 disabled:opacity-50"
            >
              {busy ? "Publication…" : "Publier le sondage"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
