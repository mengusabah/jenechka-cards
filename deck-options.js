// Shared creation control for custom decks and copied library decks.
export function spacedRepetitionControl(id, enabled = true) {
  return `<label class="spaced-setting" for="${id}">
    <span><strong>Spaced repetition</strong><small>Review words when they need a little refresh.</small></span>
    <input id="${id}" type="checkbox" role="switch" ${enabled ? 'checked' : ''}>
    <span class="spaced-switch" aria-hidden="true"></span>
  </label>`;
}
