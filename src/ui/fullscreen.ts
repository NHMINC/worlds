/** Browser fullscreen helpers. iOS Safari 17.2+ supports the API; older
 *  WebKit needs the webkit prefix. In-app browsers (and some WKWebViews)
 *  still refuse — callers should treat `unavailable` as "open in Safari". */

type FsEl = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitRequestFullScreen?: () => Promise<void> | void;
};

type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitExitFullScreen?: () => Promise<void> | void;
};

export function isFullscreen(): boolean {
  const d = document as FsDoc;
  return Boolean(document.fullscreenElement || d.webkitFullscreenElement);
}

export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

export async function toggleFullscreen(): Promise<'on' | 'off' | 'unavailable'> {
  const d = document as FsDoc;
  if (isFullscreen()) {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
      else if (d.webkitExitFullScreen) await d.webkitExitFullScreen();
      else return 'unavailable';
      return 'off';
    } catch {
      return 'unavailable';
    }
  }

  const el = document.documentElement as FsEl;
  try {
    if (el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        await el.requestFullscreen();
      }
      return 'on';
    }
    if (el.webkitRequestFullscreen) {
      await el.webkitRequestFullscreen();
      return 'on';
    }
    if (el.webkitRequestFullScreen) {
      await el.webkitRequestFullScreen();
      return 'on';
    }
  } catch {
    return 'unavailable';
  }
  return 'unavailable';
}
