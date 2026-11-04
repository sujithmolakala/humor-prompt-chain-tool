export type Theme = "light" | "dark" | "system";
export function validTheme(value: unknown): Theme {
  return value === "dark" || value === "light" ? value : "system";
}
export function resolveTheme(preference: Theme, dark: boolean) {
  return preference === "system" ? (dark ? "dark" : "light") : preference;
}
export const themeScript = `try{var p=localStorage.getItem('pct-theme');var t=p==='light'||p==='dark'?p:'system';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}`;
