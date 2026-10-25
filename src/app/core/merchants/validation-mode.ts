// Validation mode for the prototype.
//  - Guided (default): fields validate and show errors as a real product would, but missing
//    input never blocks progress, so any flow can be walked through end to end.
//  - Strict: the full production rules apply (incomplete submissions, missing documents,
//    unfinished checklists and missing review reasons are blocked).
// Toggle in the browser console: mobiDemo.strictValidation(true | false).

const KEY = 'mobi.gp.strictValidation';

export function isStrictValidation(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setStrictValidation(on: boolean): string {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not persisted; nothing else to do.
  }
  return `Strict validation ${on ? 'on' : 'off'}. Reload the page to apply it everywhere.`;
}
