import { CanDeactivateFn } from '@angular/router';

export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
  unsavedChangesMessage?(): string;
}

/** Warns before leaving a page (by default a country application) with unsaved edits. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) =>
  !component?.hasUnsavedChanges?.() || confirm(component.unsavedChangesMessage?.() ?? 'You have unsaved changes to this application. Leave without saving?');
