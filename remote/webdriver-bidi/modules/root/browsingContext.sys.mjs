/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

import { Module } from "chrome://remote/content/shared/messagehandler/Module.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AppInfo: "chrome://remote/content/shared/AppInfo.sys.mjs",
  assert: "chrome://remote/content/shared/webdriver/Assert.sys.mjs",
  BrowsingContextListener:
    "chrome://remote/content/shared/listeners/BrowsingContextListener.sys.mjs",
  capture: "chrome://remote/content/shared/Capture.sys.mjs",
  ContextDescriptorType:
    "chrome://remote/content/shared/messagehandler/MessageHandler.sys.mjs",
  error: "chrome://remote/content/shared/webdriver/Errors.sys.mjs",
  Log: "chrome://remote/content/shared/Log.sys.mjs",
  pprint: "chrome://remote/content/shared/Format.sys.mjs",
  print: "chrome://remote/content/shared/PDF.sys.mjs",
  ProgressListener: "chrome://remote/content/shared/Navigate.sys.mjs",
  TabManager: "chrome://remote/content/shared/TabManager.sys.mjs",
  waitForInitialNavigationCompleted:
    "chrome://remote/content/shared/Navigate.sys.mjs",
  WindowGlobalMessageHandler:
    "chrome://remote/content/shared/messagehandler/WindowGlobalMessageHandler.sys.mjs",
  windowManager: "chrome://remote/content/shared/WindowManager.sys.mjs",
});

XPCOMUtils.defineLazyGetter(lazy, "logger", () =>
  lazy.Log.get(lazy.Log.TYPES.WEBDRIVER_BIDI)
);

// Maximal window dimension allowed when emulating a viewport.
const MAX_WINDOW_SIZE = 10000000;

/**
 * @typedef {string} ClipRectangleType
 */

/**
 * Enum of possible clip rectangle types.
 *
 * @readonly
 * @enum {ClipRectangleType}
 */
export const ClipRectangleType = {
  Element: "element",
  Viewport: "viewport",
};

/**
 * @typedef {object} CreateType
 */

/**
 * Enum of types supported by the browsingContext.create command.
 *
 * @readonly
 * @enum {CreateType}
 */
const CreateType = {
  tab: "tab",
  window: "window",
};

/**
 * An object that contains details of a viewport.
 *
 * @typedef {object} Viewport
 *
 * @property {number} height
 *     The height of the viewport.
 * @property {number} width
 *     The width of the viewport.
 */

/**
 * @typedef {string} WaitCondition
 */

/**
 * Wait conditions supported by WebDriver BiDi for navigation.
 *
 * @enum {WaitCondition}
 */
const WaitCondition = {
  None: "none",
  Interactive: "interactive",
  Complete: "complete",
};

class BrowsingContextModule extends Module {
  #contextListener;
  #subscribedEvents;

  /**
   * Create a new module instance.
   *
   * @param {MessageHandler} messageHandler
   *     The MessageHandler instance which owns this Module instance.
   */
  constructor(messageHandler) {
    super(messageHandler);

    // Create the console-api listener and listen on "message" events.
    this.#contextListener = new lazy.BrowsingContextListener();
    this.#contextListener.on("attached", this.#onContextAttached);

    // Set of event names which have active subscriptions.
    this.#subscribedEvents = new Set();
  }

  destroy() {
    this.#contextListener.off("attached", this.#onContextAttached);
    this.#contextListener.destroy();

    this.#subscribedEvents = null;
  }

  /**
   * Used as an argument for browsingContext.captureScreenshot command, as one of the available variants
   * {BoxClipRectangle} or {ElementClipRectangle}, to represent a target of the command.
   *
   * @typedef ClipRectangle
   */

  /**
   * Used as an argument for browsingContext.captureScreenshot command
   * to represent a viewport which is going to be a target of the command.
   *
   * @typedef BoxClipRectangle
   *
   * @property {ClipRectangleType} [type=ClipRectangleType.Viewport]
   * @property {number} x
   * @property {number} y
   * @property {number} width
   * @property {number} height
   */

  /**
   * Used as an argument for browsingContext.captureScreenshot command
   * to represent an element which is going to be a target of the command.
   *
   * @typedef ElementClipRectangle
   *
   * @property {ClipRectangleType} [type=ClipRectangleType.Element]
   * @property {SharedReference} element
   * @property {boolean=} scrollIntoView
   */

  /**
   * Capture a base64-encoded screenshot of the provided browsing context.
   *
   * @param {object=} options
   * @param {string} options.context
   *     Id of the browsing context to screenshot.
   * @param {ClipRectangle=} options.clip
   *     An element or a viewport of which a screenshot should be taken.
   *     If not present, take a screenshot of the whole viewport.
   *
   * @throws {NoSuchFrameError}
   *     If the browsing context cannot be found.
   */
  async captureScreenshot(options = {}) {
    const { clip = null, context: contextId } = options;

    lazy.assert.string(
      contextId,
      `Expected "context" to be a string, got ${contextId}`
    );
    const context = this.#getBrowsingContext(contextId);

    if (clip !== null) {
      lazy.assert.object(clip, `Expected "clip" to be a object, got ${clip}`);

      const { type } = clip;
      switch (type) {
        case ClipRectangleType.Element: {
          const { element, scrollIntoView = null } = clip;

          lazy.assert.object(
            element,
            `Expected "element" to be an object, got ${element}`
          );

          if (scrollIntoView !== null) {
            lazy.assert.boolean(
              scrollIntoView,
              `Expected "scrollIntoView" to be a boolean, got ${scrollIntoView}`
            );
          }

          break;
        }

        case ClipRectangleType.Viewport: {
          const { x, y, width, height } = clip;

          lazy.assert.number(x, `Expected "x" to be a number, got ${x}`);
          lazy.assert.number(y, `Expected "y" to be a number, got ${y}`);
          lazy.assert.number(
            width,
            `Expected "width" to be a number, got ${width}`
          );
          lazy.assert.number(
            height,
            `Expected "height" to be a number, got ${height}`
          );

          break;
        }

        default:
          throw new lazy.error.InvalidArgumentError(
            `Expected "type" to be one of ${Object.values(
              ClipRectangleType
            )}, got ${type}`
          );
      }
    }

    const rect = await this.messageHandler.handleCommand({
      moduleName: "browsingContext",
      commandName: "_getScreenshotRect",
      destination: {
        type: lazy.WindowGlobalMessageHandler.type,
        id: context.id,
      },
      params: {
        clip,
      },
      retryOnAbort: true,
    });

    if (rect.width === 0 || rect.height === 0) {
      throw new lazy.error.UnableToCaptureScreen(
        `The dimensions of requested screenshot are incorrect, got width: ${rect.width} and height: ${rect.height}.`
      );
    }

    const canvas = await lazy.capture.canvas(
      context.topChromeWindow,
      context,
      rect.x,
      rect.y,
      rect.width,
      rect.height
    );

    return {
      data: lazy.capture.toBase64(canvas),
    };
  }

  /**
   * Close the provided browsing context.
   *
   * @param {object=} options
   * @param {string} options.context
   *     Id of the browsing context to close.
   *
   * @throws {NoSuchFrameError}
   *     If the browsing context cannot be found.
   * @throws {InvalidArgumentError}
   *     If the browsing context is not a top-level one.
   */
  async close(options = {}) {
    const { context: contextId } = options;

    lazy.assert.string(
      contextId,
      `Expected "context" to be a string, got ${contextId}`
    );

    const context = lazy.TabManager.getBrowsingContextById(contextId);
    if (!context) {
      throw new lazy.error.NoSuchFrameError(
        `Browsing Context with id ${contextId} not found`
      );
    }

    if (context.parent) {
      throw new lazy.error.InvalidArgumentError(
        `Browsing Context with id ${contextId} is not top-level`
      );
    }

    if (lazy.TabManager.getTabCount() === 1) {
      // The behavior when closing the last tab is currently unspecified.
      // Warn the consumer about potential issues
      lazy.logger.warn(
        `Closing the last open tab (Browsing Context id ${contextId}), expect inconsistent behavior across platforms`
      );
    }

    const tab = lazy.TabManager.getTabForBrowsingContext(context);
    await lazy.TabManager.removeTab(tab);
  }

  /**
   * Create a new browsing context using the provided type "tab" or "window".
   *
   * @param {object=} options
   * @param {string=} options.referenceContext
   *     Id of the top-level browsing context to use as reference.
   *     If options.type is "tab", the new tab will open in the same window as
   *     the reference context, and will be added next to the reference context.
   *     If options.type is "window", the reference context is ignored.
   * @param {CreateType} options.type
   *     Type of browsing context to create.
   *
   * @throws {InvalidArgumentError}
   *     If the browsing context is not a top-level one.
   * @throws {NoSuchFrameError}
   *     If the browsing context cannot be found.
   */
  async create(options = {}) {
    const { referenceContext: referenceContextId = null, type } = options;
    if (type !== CreateType.tab && type !== CreateType.window) {
      throw new lazy.error.InvalidArgumentError(
        `Expected "type" to be one of ${Object.values(CreateType)}, got ${type}`
      );
    }

    let browser;
    switch (type) {
      case "window":
        let newWindow = await lazy.windowManager.openBrowserWindow();
        browser = lazy.TabManager.getTabBrowser(newWindow).selectedBrowser;
        break;

      case "tab":
        if (!lazy.TabManager.supportsTabs()) {
          throw new lazy.error.UnsupportedOperationError(
            `browsingContext.create with type "tab" not supported in ${lazy.AppInfo.name}`
          );
        }

        let referenceTab;
        if (referenceContextId !== null) {
          lazy.assert.string(
            referenceContextId,
            lazy.pprint`Expected "referenceContext" to be a string, got ${referenceContextId}`
          );

          const referenceBrowsingContext =
            lazy.TabManager.getBrowsingContextById(referenceContextId);
          if (!referenceBrowsingContext) {
            throw new lazy.error.NoSuchFrameError(
              `Browsing Context with id ${referenceContextId} not found`
            );
          }

          if (referenceBrowsingContext.parent) {
            throw new lazy.error.InvalidArgumentError(
              `referenceContext with id ${referenceContextId} is not a top-level browsing context`
            );
          }

          referenceTab = lazy.TabManager.getTabForBrowsingContext(
            referenceBrowsingContext
          );
        }

        const tab = await lazy.TabManager.addTab({
          focus: false,
          referenceTab,
        });
        browser = lazy.TabManager.getBrowserForTab(tab);
    }

    await lazy.waitForInitialNavigationCompleted(
      browser.browsingContext.webProgress,
      {
        unloadTimeout: 5000,
      }
    );

    return {
      context: lazy.TabManager.getIdForBrowser(browser),
    };
  }

  /**
   * An object that holds the WebDriver Bidi browsing context information.
   *
   * @typedef BrowsingContextInfo
   *
   * @property {string} context
   *     The id of the browsing context.
   * @property {string=} parent
   *     The parent of the browsing context if it's the root browsing context
   *     of the to be processed browsing context tree.
   * @property {string} url
   *     The current documents location.
   * @property {Array<BrowsingContextInfo>=} children
   *     List of child browsing contexts. Only set if maxDepth hasn't been
   *     reached yet.
   */

  /**
   * An object that holds the WebDriver Bidi browsing context tree information.
   *
   * @typedef BrowsingContextGetTreeResult
   *
   * @property {Array<BrowsingContextInfo>} contexts
   *     List of child browsing contexts.
   */

  /**
   * Returns a tree of all browsing contexts that are descendents of the
   * given context, or all top-level contexts when no root is provided.
   *
   * @param {object=} options
   * @param {number=} options.maxDepth
   *     Depth of the browsing context tree to traverse. If not specified
   *     the whole tree is returned.
   * @param {string=} options.root
   *     Id of the root browsing context.
   *
   * @returns {BrowsingContextGetTreeResult}
   *     Tree of browsing context information.
   * @throws {NoSuchFrameError}
   *     If the browsing context cannot be found.
   */
  getTree(options = {}) {
    const { maxDepth = null, root: rootId = null } = options;

    if (maxDepth !== null) {
      lazy.assert.positiveInteger(
        maxDepth,
        `Expected "maxDepth" to be a positive integer, got ${maxDepth}`
      );
    }

    let contexts;
    if (rootId !== null) {
      // With a root id specified return the context info for itself
      // and the full tree.
      lazy.assert.string(
        rootId,
        `Expected "root" to be a string, got ${rootId}`
      );
      contexts = [this.#getBrowsingContext(rootId)];
    } else {
      // Return all top-level browsing contexts.
      contexts = lazy.TabManager.browsers.map(
        browser => browser.browsingContext
      );
    }

    const contextsInfo = contexts.map(context => {
      return this.#getBrowsingContextInfo(context, { maxDepth });
    });

    return { contexts: contextsInfo };
  }

  /**
   * An object that holds the WebDriver Bidi navigation information.
   *
   * @typedef BrowsingContextNavigateResult
   *
   * @property {string} navigation
   *     Unique id for this navigation.
   * @property {string} url
   *     The requested or reached URL.
   */

  /**
   * Navigate the given context to the provided url, with the provided wait condition.
   *
   * @param {object=} options
   * @param {string} options.context
   *     Id of the browsing context to navigate.
   * @param {string} options.url
   *     Url for the navigation.
   * @param {WaitCondition=} options.wait
   *     Wait condition for the navigation, one of "none", "interactive", "complete".
   *
   * @returns {BrowsingContextNavigateResult}
   *     Navigation result.
   * @throws {InvalidArgumentError}
   *     Raised if an argument is of an invalid type or value.
   * @throws {NoSuchFrameError}
   *     If the browsing context for contextId cannot be found.
   */
  async navigate(options = {}) {
    const { context: contextId, url, wait = WaitCondition.None } = options;

    lazy.assert.string(
      contextId,
      `Expected "context" to be a string, got ${contextId}`
    );

    lazy.assert.string(url, `Expected "url" to be string, got ${url}`);

    const waitConditions = Object.values(WaitCondition);
    if (!waitConditions.includes(wait)) {
      throw new lazy.error.InvalidArgumentError(
        `Expected "wait" to be one of ${waitConditions}, got ${wait}`
      );
    }

    const context = this.#getBrowsingContext(contextId);

    // webProgress will be stable even if the context navigates, retrieve it
    // immediately before doing any asynchronous call.
    const webProgress = context.webProgress;

    const base = await this.messageHandler.handleCommand({
      moduleName: "browsingContext",
      commandName: "_getBaseURL",
      destination: {
        type: lazy.WindowGlobalMessageHandler.type,
        id: context.id,
      },
      retryOnAbort: true,
    });

    let targetURI;
    try {
      const baseURI = Services.io.newURI(base);
      targetURI = Services.io.newURI(url, null, baseURI);
    } catch (e) {
      throw new lazy.error.InvalidArgumentError(
        `Expected "url" to be a valid URL (${e.message})`
      );
    }

    return this.#awaitNavigation(webProgress, targetURI, {
      wait,
    });
  }

  /**
   * An object that holds the information about margins
   * for Webdriver BiDi browsingContext.print command.
   *
   * @typedef BrowsingContextPrintMarginParameters
   *
   * @property {number=} bottom
   *     Bottom margin in cm. Defaults to 1cm (~0.4 inches).
   * @property {number=} left
   *     Left margin in cm. Defaults to 1cm (~0.4 inches).
   * @property {number=} right
   *     Right margin in cm. Defaults to 1cm (~0.4 inches).
   * @property {number=} top
   *     Top margin in cm. Defaults to 1cm (~0.4 inches).
   */

  /**
   * An object that holds the information about paper size
   * for Webdriver BiDi browsingContext.print command.
   *
   * @typedef BrowsingContextPrintPageParameters
   *
   * @property {number=} height
   *     Paper height in cm. Defaults to US letter height (27.94cm / 11 inches).
   * @property {number=} width
   *     Paper width in cm. Defaults to US letter width (21.59cm / 8.5 inches).
   */

  /**
   * Used as return value for Webdriver BiDi browsingContext.print command.
   *
   * @typedef BrowsingContextPrintResult
   *
   * @property {string} data
   *     Base64 encoded PDF representing printed document.
   */

  /**
   * Creates a paginated PDF representation of a document
   * of the provided browsing context, and returns it
   * as a Base64-encoded string.
   *
   * @param {object=} options
   * @param {string} options.context
   *     Id of the browsing context.
   * @param {boolean=} options.background
   *     Whether or not to print background colors and images.
   *     Defaults to false, which prints without background graphics.
   * @param {BrowsingContextPrintMarginParameters=} options.margin
   *     Paper margins.
   * @param {('landscape'|'portrait')=} options.orientation
   *     Paper orientation. Defaults to 'portrait'.
   * @param {BrowsingContextPrintPageParameters=} options.page
   *     Paper size.
   * @param {Array<number|string>=} options.pageRanges
   *     Paper ranges to print, e.g., ['1-5', 8, '11-13'].
   *     Defaults to the empty array, which means print all pages.
   * @param {number=} options.scale
   *     Scale of the webpage rendering. Defaults to 1.0.
   * @param {boolean=} options.shrinkToFit
   *     Whether or not to override page size as defined by CSS.
   *     Defaults to true, in which case the content will be scaled
   *     to fit the paper size.
   *
   * @returns {BrowsingContextPrintResult}
   *
   * @throws {InvalidArgumentError}
   *     Raised if an argument is of an invalid type or value.
   * @throws {NoSuchFrameError}
   *     If the browsing context cannot be found.
   */
  async print(options = {}) {
    const {
      context: contextId,
      background,
      margin,
      orientation,
      page,
      pageRanges,
      scale,
      shrinkToFit,
    } = options;

    lazy.assert.string(
      contextId,
      `Expected "context" to be a string, got ${contextId}`
    );
    const context = this.#getBrowsingContext(contextId);

    const settings = lazy.print.addDefaultSettings({
      background,
      margin,
      orientation,
      page,
      pageRanges,
      scale,
      shrinkToFit,
    });

    for (const prop of ["top", "bottom", "left", "right"]) {
      lazy.assert.positiveNumber(
        settings.margin[prop],
        lazy.pprint`margin.${prop} is not a positive number`
      );
    }
    for (const prop of ["width", "height"]) {
      lazy.assert.positiveNumber(
        settings.page[prop],
        lazy.pprint`page.${prop} is not a positive number`
      );
    }
    lazy.assert.positiveNumber(
      settings.scale,
      `scale ${settings.scale} is not a positive number`
    );
    lazy.assert.that(
      scale =>
        scale >= lazy.print.minScaleValue && scale <= lazy.print.maxScaleValue,
      `scale ${settings.scale} is outside the range ${lazy.print.minScaleValue}-${lazy.print.maxScaleValue}`
    )(settings.scale);
    lazy.assert.boolean(settings.shrinkToFit);
    lazy.assert.that(
      orientation => lazy.print.defaults.orientationValue.includes(orientation),
      `orientation ${
        settings.orientation
      } doesn't match allowed values "${lazy.print.defaults.orientationValue.join(
        "/"
      )}"`
    )(settings.orientation);
    lazy.assert.boolean(
      settings.background,
      `background ${settings.background} is not boolean`
    );
    lazy.assert.array(settings.pageRanges);

    const printSettings = await lazy.print.getPrintSettings(settings);
    const binaryString = await lazy.print.printToBinaryString(
      context,
      printSettings
    );

    return {
      data: btoa(binaryString),
    };
  }

  /**
   * Set the top-level browsing context's viewport to a given dimension.
   *
   * @param {object=} options
   * @param {string} options.context
   *     Id of the browsing context.
   * @param {Viewport|null} options.viewport
   *     Dimensions to set the viewport to, or `null` to reset it
   *     to the original dimensions.
   *
   * @throws {InvalidArgumentError}
   *     Raised if an argument is of an invalid type or value.
   * @throws UnsupportedOperationError
   *     Raised when the command is called on Android.
   */
  async setViewport(options = {}) {
    const { context: contextId, viewport } = options;

    if (lazy.AppInfo.isAndroid) {
      // Bug 1840084: Add Android support for modifying the viewport.
      throw new lazy.error.UnsupportedOperationError(
        `Command not yet supported for ${lazy.AppInfo.name}`
      );
    }

    lazy.assert.string(
      contextId,
      `Expected "context" to be a string, got ${contextId}`
    );

    const context = this.#getBrowsingContext(contextId);
    if (context.parent) {
      throw new lazy.error.InvalidArgumentError(
        `Browsing Context with id ${contextId} is not top-level`
      );
    }
    const browser = context.embedderElement;

    if (typeof viewport !== "object") {
      throw new lazy.error.InvalidArgumentError(
        `Expected "viewport" to be an object or null, got ${viewport}`
      );
    }

    let targetHeight, targetWidth;
    if (viewport !== null) {
      const { height, width } = viewport;

      targetHeight = lazy.assert.positiveInteger(
        height,
        `Expected "height" to be a positive integer, got ${height}`
      );
      targetWidth = lazy.assert.positiveInteger(
        width,
        `Expected "width" to be a positive integer, got ${width}`
      );

      if (targetHeight > MAX_WINDOW_SIZE || targetWidth > MAX_WINDOW_SIZE) {
        throw new lazy.error.UnsupportedOperationError(
          `"width" or "height" cannot be larger than ${MAX_WINDOW_SIZE} px`
        );
      }

      browser.style.setProperty("height", targetHeight + "px");
      browser.style.setProperty("width", targetWidth + "px");
    } else {
      // Reset viewport to the original dimensions
      targetHeight = browser.parentElement.clientHeight;
      targetWidth = browser.parentElement.clientWidth;

      browser.style.removeProperty("height");
      browser.style.removeProperty("width");
    }

    // Wait until the viewport has been resized
    await this.messageHandler.forwardCommand({
      moduleName: "browsingContext",
      commandName: "_awaitViewportDimensions",
      destination: {
        type: lazy.WindowGlobalMessageHandler.type,
        id: context.id,
      },
      params: {
        height: targetHeight,
        width: targetWidth,
      },
    });
  }

  /**
   * Start and await a navigation on the provided BrowsingContext. Returns a
   * promise which resolves when the navigation is done according to the provided
   * navigation strategy.
   *
   * @param {WebProgress} webProgress
   *     The WebProgress instance to observe for this navigation.
   * @param {nsIURI} targetURI
   *     The URI to navigate to.
   * @param {object} options
   * @param {WaitCondition} options.wait
   *     The WaitCondition to use to wait for the navigation.
   */
  async #awaitNavigation(webProgress, targetURI, options) {
    const { wait } = options;

    const context = webProgress.browsingContext;
    const browserId = context.browserId;

    const resolveWhenStarted = wait === WaitCondition.None;
    const listener = new lazy.ProgressListener(webProgress, {
      expectNavigation: true,
      resolveWhenStarted,
      // In case the webprogress is already navigating, always wait for an
      // explicit start flag.
      waitForExplicitStart: true,
    });

    const onDocumentInteractive = (evtName, wrappedEvt) => {
      if (webProgress.browsingContext.id !== wrappedEvt.contextId) {
        // Ignore load events for unrelated browsing contexts.
        return;
      }

      if (wrappedEvt.readyState === "interactive") {
        listener.stopIfStarted();
      }
    };

    const contextDescriptor = {
      type: lazy.ContextDescriptorType.TopBrowsingContext,
      id: browserId,
    };

    // For the Interactive wait condition, resolve as soon as
    // the document becomes interactive.
    if (wait === WaitCondition.Interactive) {
      await this.messageHandler.eventsDispatcher.on(
        "browsingContext._documentInteractive",
        contextDescriptor,
        onDocumentInteractive
      );
    }

    const navigated = listener.start();
    navigated.finally(async () => {
      if (listener.isStarted) {
        listener.stop();
      }

      if (wait === WaitCondition.Interactive) {
        await this.messageHandler.eventsDispatcher.off(
          "browsingContext._documentInteractive",
          contextDescriptor,
          onDocumentInteractive
        );
      }
    });

    context.loadURI(targetURI, {
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_IS_LINK,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      hasValidUserGestureActivation: true,
    });
    await navigated;

    let url;
    if (wait === WaitCondition.None) {
      // If wait condition is None, the navigation resolved before the current
      // context has navigated.
      url = listener.targetURI.spec;
    } else {
      url = listener.currentURI.spec;
    }

    const navigation =
      this.messageHandler.navigationManager.getNavigationForBrowsingContext(
        webProgress.browsingContext
      );
    return {
      navigation: navigation ? navigation.id : null,
      url,
    };
  }

  /**
   * Retrieves a browsing context based on its id.
   *
   * @param {number} contextId
   *     Id of the browsing context.
   * @returns {BrowsingContext=}
   *     The browsing context or null if <var>contextId</var> is null.
   * @throws {NoSuchFrameError}
   *     If the browsing context cannot be found.
   */
  #getBrowsingContext(contextId) {
    // The WebDriver BiDi specification expects null to be
    // returned if no browsing context id has been specified.
    if (contextId === null) {
      return null;
    }

    const context = lazy.TabManager.getBrowsingContextById(contextId);
    if (context === null) {
      throw new lazy.error.NoSuchFrameError(
        `Browsing Context with id ${contextId} not found`
      );
    }

    return context;
  }

  /**
   * Get the WebDriver BiDi browsing context information.
   *
   * @param {BrowsingContext} context
   *     The browsing context to get the information from.
   * @param {object=} options
   * @param {boolean=} options.isRoot
   *     Flag that indicates if this browsing context is the root of all the
   *     browsing contexts to be returned. Defaults to true.
   * @param {number=} options.maxDepth
   *     Depth of the browsing context tree to traverse. If not specified
   *     the whole tree is returned.
   * @returns {BrowsingContextInfo}
   *     The information about the browsing context.
   */
  #getBrowsingContextInfo(context, options = {}) {
    const { isRoot = true, maxDepth = null } = options;

    let children = null;
    if (maxDepth === null || maxDepth > 0) {
      children = context.children.map(context =>
        this.#getBrowsingContextInfo(context, {
          maxDepth: maxDepth === null ? maxDepth : maxDepth - 1,
          isRoot: false,
        })
      );
    }

    const contextInfo = {
      context: lazy.TabManager.getIdForBrowsingContext(context),
      url: context.currentURI.spec,
      children,
    };

    if (isRoot) {
      // Only emit the parent id for the top-most browsing context.
      const parentId = lazy.TabManager.getIdForBrowsingContext(context.parent);
      contextInfo.parent = parentId;
    }

    return contextInfo;
  }

  #onContextAttached = async (eventName, data = {}) => {
    const { browsingContext, why } = data;

    // Filter out top-level browsing contexts that are created because of a
    // cross-group navigation.
    if (why === "replace") {
      return;
    }

    // Filter out notifications for chrome context until support gets
    // added (bug 1722679).
    if (!browsingContext.webProgress) {
      return;
    }

    const browsingContextInfo = this.#getBrowsingContextInfo(browsingContext, {
      maxDepth: 0,
    });

    // This event is emitted from the parent process but for a given browsing
    // context. Set the event's contextInfo to the message handler corresponding
    // to this browsing context.
    const contextInfo = {
      contextId: browsingContext.id,
      type: lazy.WindowGlobalMessageHandler.type,
    };
    this.emitEvent(
      "browsingContext.contextCreated",
      browsingContextInfo,
      contextInfo
    );
  };

  #subscribeEvent(event) {
    if (event === "browsingContext.contextCreated") {
      this.#contextListener.startListening();
      this.#subscribedEvents.add(event);
    }
  }

  #unsubscribeEvent(event) {
    if (event === "browsingContext.contextCreated") {
      this.#contextListener.stopListening();
      this.#subscribedEvents.delete(event);
    }
  }

  /**
   * Internal commands
   */

  _applySessionData(params) {
    // TODO: Bug 1775231. Move this logic to a shared module or an abstract
    // class.
    const { category } = params;
    if (category === "event") {
      const filteredSessionData = params.sessionData.filter(item =>
        this.messageHandler.matchesContext(item.contextDescriptor)
      );
      for (const event of this.#subscribedEvents.values()) {
        const hasSessionItem = filteredSessionData.some(
          item => item.value === event
        );
        // If there are no session items for this context, we should unsubscribe from the event.
        if (!hasSessionItem) {
          this.#unsubscribeEvent(event);
        }
      }

      // Subscribe to all events, which have an item in SessionData.
      for (const { value } of filteredSessionData) {
        this.#subscribeEvent(value);
      }
    }
  }

  static get supportedEvents() {
    return [
      "browsingContext.contextCreated",
      "browsingContext.domContentLoaded",
      "browsingContext.load",
    ];
  }
}

export const browsingContext = BrowsingContextModule;
