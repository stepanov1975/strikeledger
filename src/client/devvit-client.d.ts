declare module '@devvit/client' {
  export type WebViewMode = 'inline' | 'expanded';

  export function getWebViewMode(): WebViewMode;

  export function requestExpandedMode(event: MouseEvent, entry: string): void;

  export function addWebViewModeListener(
    callback: (mode: WebViewMode) => void
  ): void;
}
