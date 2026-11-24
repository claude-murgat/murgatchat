import { useState } from "react";
import { api } from "../api.ts";
import type { Poll } from "../types.ts";
import {
  POLL_OPTION_MAX,
  POLL_OPTIONS_MAX,
  myVotes,
  nextSelection,
  pollErrorText,
  share,
  votersCountLabel,
  votersLabel,
} from "../polls.ts";

interface PollCardProps {
  poll: Poll;
  /** Auteur du message qui porte le sondage. */
  authorId: string | undefined;
  currentUserId: string | undefined;
  /** Admin du salon ou du chat : peut clôturer le sondage d'un autre. */
  canModerate: boolean;
  /** Sondage à jour renvoyé par le serveur (le même arrive aussi par `poll:update`). */
  onChange: (poll: Poll) => void;
}

// Un sondage dans le fil : la question, chaque réponse avec sa barre, son
// nombre de voix et qui a voté, un clic pour voter. Les résultats restent
// visibles une fois le sondage clôturé.
export default function PollCard({ poll, authorId, currentUserId, canModerate, onChange }: PollCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const closed = !!poll.closedAt;
  const mine = myVotes(poll, currentUserId);
  const isAuthor = !!currentUserId && currentUserId === authorId;
  const canAdd = !closed && (poll.allowAddOptions || isAuthor) && poll.options.length < POLL_OPTIONS_MAX;
  const canClose = !closed && (isAuthor || canModerate);

  // Une action à la fois : un double clic n'envoie pas deux sélections
  // contradictoires, et la réponse du serveur fait foi.
  async function run(action: () => Promise<{ poll: Poll }>, fallback: string) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      onChange(res.poll);
      return true;
    } catch (err) {
      setError(pollErrorText(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function vote(optionId: string) {
    if (closed) return;
    const selection = nextSelection(poll, mine, optionId);
    run(() => api.votePoll(poll.id, selection), "Votre vote n'a pas été enregistré. Réessayez.");
  }

  async function addOption() {
    const text = draft.trim();
    if (!text) return;
    const ok = await run(() => api.addPollOption(poll.id, text), "La réponse n'a pas été ajoutée.");
    if (ok) {
      setDraft("");
      setAdding(false);
    }
  }

  function close() {
    if (!window.confirm("Clôturer ce sondage ? Plus personne ne pourra voter.")) return;
    run(() => api.closePoll(poll.id), "Le sondage n'a pas pu être clôturé.");
  }

  return (
    <div
      className="mt-1 max-w-md rounded-lg border border-slate-200 bg-white p-3 select-none"
      data-testid="poll"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span className="font-semibold text-aubergine-700">📊 Sondage</span>
        <span>·</span>
        <span>{poll.multiple ? "Plusieurs réponses possibles" : "Une seule réponse"}</span>
        {closed && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">Clôturé</span>
        )}
      </div>
      <div className="mt-1 font-semibold text-slate-900 wrap-break-word select-text">{poll.question}</div>

      <ul
        className="mt-2 space-y-1.5"
        role={poll.multiple ? "group" : "radiogroup"}
        aria-label={poll.question}
      >
        {poll.options.map((o) => {
          const selected = mine.includes(o.id);
          const pct = share(o.count, poll.voterCount);
          return (
            <li key={o.id}>
              <button
                type="button"
                role={poll.multiple ? "checkbox" : "radio"}
                aria-checked={selected}
                disabled={closed || busy}
                onClick={() => vote(o.id)}
                title={o.count ? votersLabel(o.voters) : undefined}
                className={`relative w-full overflow-hidden rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                  selected ? "border-aubergine-700" : "border-slate-200"
                } ${closed ? "cursor-default" : "hover:border-aubergine-700/60 disabled:cursor-wait"}`}
              >
                {/* Barre de résultat, derrière le texte. */}
                <span
                  aria-hidden="true"
                  className={`absolute inset-y-0 left-0 ${selected ? "bg-aubergine-700/15" : "bg-slate-100"}`}
                  style={{ width: `${pct}%` }}
                />
                <span className="relative flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`grid h-4 w-4 shrink-0 place-items-center border ${
                      poll.multiple ? "rounded-sm" : "rounded-full"
                    } ${selected ? "border-aubergine-700 bg-aubergine-700 text-white" : "border-slate-400 bg-white"}`}
                  >
                    {selected && (poll.multiple ? <span className="text-[10px] leading-none">✓</span> : <span className="h-1.5 w-1.5 rounded-full bg-white" />)}
                  </span>
                  <span className="flex-1 min-w-0 wrap-break-word">{o.text}</span>
                  <span className="shrink-0 tabular-nums text-xs text-slate-500">
                    {o.count > 0 ? `${o.count} · ${pct} %` : "0"}
                  </span>
                </span>
                {o.count > 0 && (
                  <span className="relative mt-0.5 block truncate text-xs text-slate-500">
                    {votersLabel(o.voters)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {adding && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addOption();
          }}
        >
          <input
            autoFocus
            aria-label="Nouvelle réponse"
            className="flex-1 min-w-0 rounded-md border px-2 py-1.5 text-sm"
            placeholder="Votre réponse"
            value={draft}
            maxLength={POLL_OPTION_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAdding(false);
                setDraft("");
              }
            }}
          />
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            className="rounded-md bg-aubergine-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Ajouter
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
        <span>{votersCountLabel(poll.voterCount)}</span>
        {canAdd && !adding && (
          <button type="button" onClick={() => setAdding(true)} className="text-aubergine-700 hover:underline">
            + Ajouter une réponse
          </button>
        )}
        {canClose && (
          <button type="button" onClick={close} disabled={busy} className="text-slate-600 hover:underline">
            Clôturer le sondage
          </button>
        )}
      </div>
    </div>
  );
}
