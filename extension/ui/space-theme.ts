// A space's theme (2026-11-20, Tirth: a theme per space; chosen as it's made, the theme of the space it was made from
// by default; changed in its editor, its menu's Theme, or Settings' Theme for the space shown). A space keeps a theme's
// id (state/model.ts `theme`); none (spaces from before) is the profile's settings.theme. One that isn't there (an
// imported theme removed since) is drawn with the profile's, else Arcadia: never an error, the space's choice kept.
import { PACKAGE_THEMES, PACKAGE_THEME_NAMES } from '../themes/packages.ts';
import { userThemeList } from './settings-form.ts';

export type ThemeChoice = { id: string, name: string };

/** Whether this host draws each space's theme (`features.spaceThemes`: Margin.app's own window). */
export const spaceThemesOn = (features: any) => features?.spaceThemes === true;

/** The themes a space can have: the built-in ones, then Margin.app's imported ones (`features.userThemes`). */
export function themeChoices(features: any): ThemeChoice[] {
  return [
    ...PACKAGE_THEMES.map((id) => ({ id, name: (PACKAGE_THEME_NAMES as Record<string, string>)[id] ?? id })),
    ...userThemeList(features?.userThemes).map((t) => ({ id: t.id, name: t.name || t.id })),
  ];
}

/** The theme a space is drawn with: its own if it's there, else the profile's if that is, else Arcadia. */
export function spaceThemeId(space: { theme?: string } | null | undefined, settings: any, features: any, choices: ThemeChoice[] = themeChoices(features)): string {
  const there = (id: unknown): id is string => typeof id === 'string' && choices.some((c) => c.id === id);
  if (there(space?.theme)) return space.theme;
  if (there(settings?.theme)) return settings.theme;
  return PACKAGE_THEMES[0];
}
