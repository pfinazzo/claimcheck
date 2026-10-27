/**
 * The three looks Desk can have: light, dark, or whichever the computer is using.
 * The main process, the page and the saved settings all use this one list.
 *
 * @author Patrick Finazzo
 */

export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** Until the person picks one, Desk follows the computer. */
export const DEFAULT_THEME_CHOICE: ThemeChoice = 'system';

/** The words on the switch. "Auto" is the plain way to say "follow the computer". */
export const THEME_LABELS = new Map<ThemeChoice, string>([
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'Auto'],
]);

/** What each choice does, for the hover text and screen readers. */
export const THEME_HINTS = new Map<ThemeChoice, string>([
  ['light', 'Always use the light look'],
  ['dark', 'Always use the dark look'],
  ['system', 'Use whichever look the computer is using'],
]);

export const isKnownThemeChoice = ({ value }: { value: unknown }): boolean => THEME_CHOICES.some((choice) => choice === value);

/** Saved settings are untrusted: anything that is not one of the three reads as the default. */
export const toThemeChoice = ({ value }: { value: unknown }): ThemeChoice => THEME_CHOICES.find((choice) => choice === value) ?? DEFAULT_THEME_CHOICE;
