/**
 * Completion heuristic for a streaming answer.
 *
 * Text is stable when the page is no longer streaming and the assistant text
 * stayed byte-identical across two consecutive polls. This is necessary but
 * NOT sufficient: callers must also verify this turn's terminal control. The
 * caller chooses the poll interval, so the same rule works for a fast page and
 * a slow one; anything ambiguous stays incomplete and the engine keeps waiting.
 */
export interface CompletionState {
  lastText: string
  stable: number
  answered: boolean
}

export function advanceCompletion(
  previous: { lastText: string; stable: number },
  text: string,
  streaming: boolean,
): CompletionState {
  if (streaming || text === '') {
    return { lastText: previous.lastText, stable: 0, answered: false }
  }
  if (text === previous.lastText) {
    const stable = previous.stable + 1
    return { lastText: text, stable, answered: stable >= 2 }
  }
  return { lastText: text, stable: 1, answered: false }
}
