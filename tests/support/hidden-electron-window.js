function installHiddenElectronWindowHarness({ BrowserWindow, targetGlobal = globalThis }) {
  const requestedAlwaysOnTop = new WeakMap();
  const createdWindows = new Set();

  class HiddenBrowserWindow extends BrowserWindow {
    constructor(options = {}) {
      super({
        ...options,
        show: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: false,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          ...(options.webPreferences || {}),
          offscreen: true,
          backgroundThrottling: false
        }
      });
      createdWindows.add(this);
      if (typeof this.setIgnoreMouseEvents === 'function') this.setIgnoreMouseEvents(true);
    }

    show() {}
    showInactive() {}
    focus() {}
    restore() {}
    moveTop() {}

    setAlwaysOnTop(value) {
      requestedAlwaysOnTop.set(this, Boolean(value));
    }

    isAlwaysOnTop() {
      return requestedAlwaysOnTop.get(this) === true;
    }
  }

  targetGlobal.__mhuBrowserWindowConstructor = HiddenBrowserWindow;

  return {
    getWindows() {
      return [...createdWindows].filter(window => typeof window.isDestroyed !== 'function' || !window.isDestroyed());
    },
    isAlwaysOnTopRequested(window) {
      return requestedAlwaysOnTop.get(window) === true;
    },
    isNativeSurfaceSuppressed(window) {
      return window.isVisible() === false && window.isFocused() === false;
    },
    areNativeSurfacesSuppressed(windows) {
      return windows.every(window => window.isVisible() === false && window.isFocused() === false);
    }
  };
}

module.exports = { installHiddenElectronWindowHarness };
