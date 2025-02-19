/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PageEventManager: "resource://activity-stream/lib/PageEventManager.sys.mjs",
});

XPCOMUtils.defineLazyModuleGetters(lazy, {
  AboutWelcomeParent: "resource:///actors/AboutWelcomeParent.jsm",
  ASRouter: "resource://activity-stream/lib/ASRouter.jsm",
});

const TRANSITION_MS = 500;
const CONTAINER_ID = "multi-stage-message-root";
const BUNDLE_SRC =
  "resource://activity-stream/aboutwelcome/aboutwelcome.bundle.js";

/**
 * Feature Callout fetches messages relevant to a given source and displays them
 * in the parent page pointing to the element they describe.
 */
export class FeatureCallout {
  /**
   * @typedef {Object} FeatureCalloutOptions
   * @property {Window} win window in which messages will be rendered.
   * @property {{name: String, defaultValue?: String}} [pref] optional pref used
   *   to track progress through a given feature tour. for example:
   *   {
   *     name: "browser.pdfjs.feature-tour",
   *     defaultValue: '{ screen: "FEATURE_CALLOUT_1", complete: false }',
   *   }
   *   or { name: "browser.pdfjs.feature-tour" } (defaultValue is optional)
   * @property {String} [location] string to pass as the page when requesting
   *   messages from ASRouter and sending telemetry.
   * @property {String} context either "chrome" or "content". "chrome" is used
   *   when the callout is shown in the browser chrome, and "content" is used
   *   when the callout is shown in a content page like Firefox View.
   * @property {MozBrowser} [browser] <browser> element responsible for the
   *   feature callout. for content pages, this is the browser element that the
   *   callout is being shown in. for chrome, this is the active browser.
   * @property {Function} [listener] callback to be invoked on various callout
   *   events to keep the broker informed of the callout's state.
   * @property {FeatureCalloutTheme} [theme] @see FeatureCallout.themePresets
   */

  /** @param {FeatureCalloutOptions} options */
  constructor({
    win,
    pref,
    location,
    context,
    browser,
    listener,
    theme = {},
  } = {}) {
    this.win = win;
    this.doc = win.document;
    this.browser = browser || this.win.docShell.chromeEventHandler;
    this.config = null;
    this.loadingConfig = false;
    this.message = null;
    if (pref?.name) {
      this.pref = pref;
    }
    this._featureTourProgress = null;
    this.currentScreen = null;
    this.renderObserver = null;
    this.savedActiveElement = null;
    this.ready = false;
    this._positionListenersRegistered = false;
    this.AWSetup = false;
    this.location = location;
    this.context = context;
    this.listener = listener;
    this._initTheme(theme);

    this._handlePrefChange = this._handlePrefChange.bind(this);

    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "cfrFeaturesUserPref",
      "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features",
      true
    );
    this.setupFeatureTourProgress();

    // When the window is focused, ensure tour is synced with tours in any other
    // instances of the parent page. This does not apply when the Callout is
    // shown in the browser chrome.
    if (this.context !== "chrome") {
      this.win.addEventListener("visibilitychange", this);
    }

    this.win.addEventListener("unload", this);
  }

  setupFeatureTourProgress() {
    if (this.featureTourProgress) {
      return;
    }
    if (this.pref?.name) {
      this._handlePrefChange(null, null, this.pref.name);
      Services.prefs.addObserver(this.pref.name, this._handlePrefChange);
    }
  }

  teardownFeatureTourProgress() {
    if (this.pref?.name) {
      Services.prefs.removeObserver(this.pref.name, this._handlePrefChange);
    }
    this._featureTourProgress = null;
  }

  get featureTourProgress() {
    return this._featureTourProgress;
  }

  /**
   * Get the page event manager and instantiate it if necessary. Only used by
   * _attachPageEventListeners, since we don't want to do this unnecessary work
   * if a message with page event listeners hasn't loaded. Other consumers
   * should use `this._pageEventManager?.property` instead.
   */
  get _loadPageEventManager() {
    if (!this._pageEventManager) {
      this._pageEventManager = new lazy.PageEventManager(this.doc);
    }
    return this._pageEventManager;
  }

  _addPositionListeners() {
    if (!this._positionListenersRegistered) {
      this.win.addEventListener("resize", this);
      const parentEl = this.doc.querySelector(
        this.currentScreen?.parent_selector
      );
      parentEl?.addEventListener("toggle", this);
      this._positionListenersRegistered = true;
    }
  }

  _removePositionListeners() {
    if (this._positionListenersRegistered) {
      this.win.removeEventListener("resize", this);
      const parentEl = this.doc.querySelector(
        this.currentScreen?.parent_selector
      );
      parentEl?.removeEventListener("toggle", this);
      this._positionListenersRegistered = false;
    }
  }

  _handlePrefChange(subject, topic, prefName) {
    switch (prefName) {
      case this.pref?.name:
        try {
          this._featureTourProgress = JSON.parse(
            Services.prefs.getStringPref(
              this.pref.name,
              this.pref.defaultValue ?? null
            )
          );
        } catch (error) {
          this._featureTourProgress = null;
        }
        if (topic === "nsPref:changed") {
          this._maybeAdvanceScreens();
        }
        break;
    }
  }

  async _maybeAdvanceScreens() {
    if (this.doc.visibilityState === "hidden" || !this.featureTourProgress) {
      return;
    }

    // If we have more than one screen, it means that we're displaying a feature
    // tour, and transitions are handled based on the value of a tour progress
    // pref. Otherwise, just show the feature callout. If a pref change results
    // from an event in a Spotlight message, initialize the feature callout with
    // the next message in the tour.
    if (
      this.config?.screens.length === 1 ||
      this.currentScreen == "spotlight"
    ) {
      this.showFeatureCallout();
      return;
    }

    let prefVal = this.featureTourProgress;
    // End the tour according to the tour progress pref or if the user disabled
    // contextual feature recommendations.
    if (prefVal.complete || !this.cfrFeaturesUserPref) {
      this.endTour();
    } else if (prefVal.screen !== this.currentScreen?.id) {
      // Pref changes only matter to us insofar as they let us advance an
      // ongoing tour. If the tour was closed and the pref changed later, e.g.
      // by editing the pref directly, we don't want to start up the tour again.
      // This is more important in the chrome, which is always open.
      if (this.context === "chrome" && !this.currentScreen) {
        return;
      }
      this.ready = false;
      this._container?.classList.add("hidden");
      this._pageEventManager?.clear();
      // wait for fade out transition
      this.win.setTimeout(async () => {
        // If the initial message was deployed from outside by ASRouter as a
        // result of a trigger, we can't continue it through _loadConfig, since
        // that effectively requests a message with a `featureCalloutCheck`
        // trigger. So we need to load up the same message again, merely
        // changing the startScreen index. Just check that the next screen and
        // the current screen are both within the message's screens array.
        let nextMessage = null;
        if (
          this.context === "chrome" &&
          this.message?.trigger.id !== "featureCalloutCheck"
        ) {
          if (
            this.config?.screens.some(s => s.id === this.currentScreen?.id) &&
            this.config.screens.some(s => s.id === prefVal.screen)
          ) {
            nextMessage = this.message;
          }
        }
        await this._updateConfig(nextMessage);
        this._container?.remove();
        this._removePositionListeners();
        this.doc.querySelector(`[src="${BUNDLE_SRC}"]`)?.remove();
        this._addCalloutLinkElements();
        this._setupWindowFunctions();
        await this._renderCallout();
      }, TRANSITION_MS);
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "focus": {
        if (!this._container) {
          return;
        }
        // If focus has fired on the feature callout window itself, or on something
        // contained in that window, ignore it, as we can't possibly place the focus
        // on it after the callout is closd.
        if (
          event.target === this._container ||
          (Node.isInstance(event.target) &&
            this._container.contains(event.target))
        ) {
          return;
        }
        // Save this so that if the next focus event is re-entering the popup,
        // then we'll put the focus back here where the user left it once we exit
        // the feature callout series.
        this.savedActiveElement = this.doc.activeElement;
        break;
      }

      case "keypress": {
        if (event.key !== "Escape") {
          return;
        }
        if (!this._container) {
          return;
        }
        let focusedElement =
          this.context === "chrome"
            ? Services.focus.focusedElement
            : this.doc.activeElement;
        // If the window has a focused element, let it handle the ESC key instead.
        if (
          !focusedElement ||
          focusedElement === this.doc.body ||
          focusedElement === this.browser ||
          this._container.contains(focusedElement)
        ) {
          this.win.AWSendEventTelemetry?.({
            event: "DISMISS",
            event_context: {
              source: `KEY_${event.key}`,
              page: this.location,
            },
            message_id: this.config?.id.toUpperCase(),
          });
          this._dismiss();
          event.preventDefault();
        }
        break;
      }

      case "visibilitychange":
        this._maybeAdvanceScreens();
        break;

      case "resize":
      case "toggle":
        this.win.requestAnimationFrame(() => this._positionCallout());
        break;

      case "unload":
        try {
          this.teardownFeatureTourProgress();
        } catch (error) {}
        break;

      default:
    }
  }

  _addCalloutLinkElements() {
    const addStylesheet = href => {
      if (this.doc.querySelector(`link[href="${href}"]`)) {
        return;
      }
      const link = this.doc.head.appendChild(this.doc.createElement("link"));
      link.rel = "stylesheet";
      link.href = href;
    };
    const addLocalization = hrefs => {
      hrefs.forEach(href => {
        // eslint-disable-next-line no-undef
        this.win.MozXULElement.insertFTLIfNeeded(href);
      });
    };

    // Update styling to be compatible with about:welcome bundle
    addStylesheet(
      "chrome://activity-stream/content/aboutwelcome/aboutwelcome.css"
    );

    addLocalization([
      "browser/newtab/onboarding.ftl",
      "browser/spotlight.ftl",
      "branding/brand.ftl",
      "toolkit/branding/brandings.ftl",
      "browser/newtab/asrouter.ftl",
      "browser/featureCallout.ftl",
    ]);
  }

  _createContainer() {
    let parent = this.doc.querySelector(this.currentScreen?.parent_selector);
    // Don't render the callout if the parent element is not present.
    // This means the message was misconfigured, mistargeted, or the
    // content of the parent page is not as expected.
    if (!parent && !this.currentScreen?.content?.callout_position_override) {
      if (this.message?.template === "feature_callout") {
        Services.telemetry.recordEvent(
          "messaging_experiments",
          "feature_callout",
          "create_failed",
          `${this.message.id || "no_message"}-${
            this.currentScreen?.parent_selector || "no_current_screen"
          }`
        );
      }

      return false;
    }

    if (!this._container?.parentElement) {
      this._container = this.doc.createElement("div");
      this._container.classList.add(
        "onboardingContainer",
        "featureCallout",
        "callout-arrow",
        "hidden"
      );
      this._container.classList.toggle(
        "hidden-arrow",
        !!this.currentScreen?.content?.hide_arrow
      );
      this._container.id = CONTAINER_ID;
      // This value is reported as the "page" in about:welcome telemetry
      this._container.dataset.page = this.location;
      this._container.setAttribute(
        "aria-describedby",
        `#${CONTAINER_ID} .welcome-text`
      );
      this._container.tabIndex = 0;
      this._applyTheme();
      this.doc.body.prepend(this._container);
    }
    return this._container;
  }

  /**
   * Set callout's position relative to parent element
   */
  _positionCallout() {
    const container = this._container;
    const parentEl = this.doc.querySelector(
      this.currentScreen?.parent_selector
    );
    const doc = this.doc;
    // All possible arrow positions
    // If the position contains a dash, the value before the dash
    // refers to which edge of the feature callout the arrow points
    // from. The value after the dash describes where along that edge
    // the arrow sits, with middle as the default.
    const arrowPositions = [
      "top",
      "bottom",
      "end",
      "start",
      "top-end",
      "top-start",
      "top-center-arrow-end",
      "top-center-arrow-start",
    ];
    const arrowPosition = this.currentScreen?.content?.arrow_position || "top";
    // Callout arrow should overlap the parent element by 5px
    const arrowWidth = 12;
    const arrowHeight = Math.hypot(arrowWidth, arrowWidth);
    // If the message specifies no overlap, we move the callout away so the
    // arrow doesn't overlap at all.
    const overlapAmount = this.currentScreen?.content?.noCalloutOverlap ? 0 : 5;
    let overlap = overlapAmount - arrowHeight;
    // Is the document layout right to left?
    const RTL = this.doc.dir === "rtl";
    const customPosition =
      this.currentScreen?.content.callout_position_override;

    // Early exit if the container doesn't exist,
    // or if we're missing a parent element and don't have a custom callout position
    if (!container || (!parentEl && !customPosition)) {
      return;
    }

    const getOffset = el => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left + this.win.scrollX,
        right: rect.right + this.win.scrollX,
        top: rect.top + this.win.scrollY,
        bottom: rect.bottom + this.win.scrollY,
      };
    };

    const clearPosition = () => {
      Object.keys(positioners).forEach(position => {
        container.style[position] = "unset";
      });
      arrowPositions.forEach(position => {
        if (container.classList.contains(`arrow-${position}`)) {
          container.classList.remove(`arrow-${position}`);
        }
        if (container.classList.contains(`arrow-inline-${position}`)) {
          container.classList.remove(`arrow-inline-${position}`);
        }
      });
    };

    const addArrowPositionClassToContainer = finalArrowPosition => {
      let className;
      switch (finalArrowPosition) {
        case "bottom":
          className = "arrow-bottom";
          break;
        case "left":
          className = "arrow-inline-start";
          break;
        case "right":
          className = "arrow-inline-end";
          break;
        case "top-start":
        case "top-center-arrow-start":
          className = RTL ? "arrow-top-end" : "arrow-top-start";
          break;
        case "top-end":
        case "top-center-arrow-end":
          className = RTL ? "arrow-top-start" : "arrow-top-end";
          break;
        case "top":
        default:
          className = "arrow-top";
          break;
      }

      container.classList.add(className);
    };

    const addValueToPixelValue = (value, pixelValue) => {
      return `${Number(pixelValue.split("px")[0]) + value}px`;
    };

    const subtractPixelValueFromValue = (pixelValue, value) => {
      return `${value - Number(pixelValue.split("px")[0])}px`;
    };

    const overridePosition = () => {
      // We override _every_ positioner here, because we want to manually set all
      // container.style.positions in every positioner's "position" function
      // regardless of the actual arrow position
      // Note: We override the position functions with new functions here,
      // but they don't actually get executed until the respective position functions are called
      // and this function is not executed unless the message has a custom position property.

      // We're positioning relative to a parent element's bounds,
      // if that parent element exists.

      for (const position in positioners) {
        positioners[position].position = () => {
          if (customPosition.top) {
            container.style.top = addValueToPixelValue(
              parentEl.getBoundingClientRect().top,
              customPosition.top
            );
          }

          if (customPosition.left) {
            const leftPosition = addValueToPixelValue(
              parentEl.getBoundingClientRect().left,
              customPosition.left
            );

            RTL
              ? (container.style.right = leftPosition)
              : (container.style.left = leftPosition);
          }

          if (customPosition.right) {
            const rightPosition = subtractPixelValueFromValue(
              customPosition.right,
              parentEl.getBoundingClientRect().right -
                container.getBoundingClientRect().width
            );

            RTL
              ? (container.style.right = rightPosition)
              : (container.style.left = rightPosition);
          }

          if (customPosition.bottom) {
            container.style.top = subtractPixelValueFromValue(
              customPosition.bottom,
              parentEl.getBoundingClientRect().bottom -
                container.getBoundingClientRect().height
            );
          }
        };
      }
    };

    // Remember not to use HTML-only properties/methods like offsetHeight. Try
    // to use getBoundingClientRect() instead, which is available on XUL
    // elements. This is necessary to support feature callout in chrome, which
    // is still largely XUL-based.
    const positioners = {
      // availableSpace should be the space between the edge of the page in the
      // assumed direction and the edge of the parent (with the callout being
      // intended to fit between those two edges) while needed space should be
      // the space necessary to fit the callout container.
      top: {
        availableSpace() {
          return (
            doc.documentElement.clientHeight -
            getOffset(parentEl).top -
            parentEl.getBoundingClientRect().height
          );
        },
        neededSpace: container.getBoundingClientRect().height - overlap,
        position() {
          // Point to an element above the callout
          let containerTop =
            getOffset(parentEl).top +
            parentEl.getBoundingClientRect().height -
            overlap;
          container.style.top = `${Math.max(0, containerTop)}px`;
          alignHorizontally("center");
        },
      },
      bottom: {
        availableSpace() {
          return getOffset(parentEl).top;
        },
        neededSpace: container.getBoundingClientRect().height - overlap,
        position() {
          // Point to an element below the callout
          let containerTop =
            getOffset(parentEl).top -
            container.getBoundingClientRect().height +
            overlap;
          container.style.top = `${Math.max(0, containerTop)}px`;
          alignHorizontally("center");
        },
      },
      right: {
        availableSpace() {
          return getOffset(parentEl).left;
        },
        neededSpace: container.getBoundingClientRect().width - overlap,
        position() {
          // Point to an element to the right of the callout
          let containerLeft =
            getOffset(parentEl).left -
            container.getBoundingClientRect().width +
            overlap;
          container.style.left = `${Math.max(0, containerLeft)}px`;
          if (
            container.getBoundingClientRect().height <=
            parentEl.getBoundingClientRect().height
          ) {
            container.style.top = `${getOffset(parentEl).top}px`;
          } else {
            centerVertically();
          }
        },
      },
      left: {
        availableSpace() {
          return doc.documentElement.clientWidth - getOffset(parentEl).right;
        },
        neededSpace: container.getBoundingClientRect().width - overlap,
        position() {
          // Point to an element to the left of the callout
          let containerLeft =
            getOffset(parentEl).left +
            parentEl.getBoundingClientRect().width -
            overlap;
          container.style.left = `${Math.max(0, containerLeft)}px`;
          if (
            container.getBoundingClientRect().height <=
            parentEl.getBoundingClientRect().height
          ) {
            container.style.top = `${getOffset(parentEl).top}px`;
          } else {
            centerVertically();
          }
        },
      },
      "top-start": {
        availableSpace() {
          return (
            doc.documentElement.clientHeight -
            getOffset(parentEl).top -
            parentEl.getBoundingClientRect().height
          );
        },
        neededSpace: container.getBoundingClientRect().height - overlap,
        position() {
          // Point to an element above and at the start of the callout
          let containerTop =
            getOffset(parentEl).top +
            parentEl.getBoundingClientRect().height -
            overlap;
          container.style.top = `${Math.max(0, containerTop)}px`;
          alignHorizontally("start");
        },
      },
      "top-end": {
        availableSpace() {
          return (
            doc.documentElement.clientHeight -
            getOffset(parentEl).top -
            parentEl.getBoundingClientRect().height
          );
        },
        neededSpace: container.getBoundingClientRect().height - overlap,
        position() {
          // Point to an element above and at the end of the callout
          let containerTop =
            getOffset(parentEl).top +
            parentEl.getBoundingClientRect().height -
            overlap;
          container.style.top = `${Math.max(0, containerTop)}px`;
          alignHorizontally("end");
        },
      },
      "top-center-arrow-start": {
        availableSpace() {
          return (
            doc.documentElement.clientHeight -
            getOffset(parentEl).top -
            parentEl.getBoundingClientRect().height
          );
        },
        neededSpace: container.getBoundingClientRect().height - overlap,
        position() {
          // Point to an element above and at the start of the callout
          let containerTop =
            getOffset(parentEl).top +
            parentEl.getBoundingClientRect().height -
            overlap;
          container.style.top = `${Math.max(0, containerTop)}px`;
          alignHorizontally("center-arrow-start");
        },
      },
      "top-center-arrow-end": {
        availableSpace() {
          return (
            doc.documentElement.clientHeight -
            getOffset(parentEl).top -
            parentEl.getBoundingClientRect().height
          );
        },
        neededSpace: container.getBoundingClientRect().height - overlap,
        position() {
          // Point to an element above and at the end of the callout
          let containerTop =
            getOffset(parentEl).top +
            parentEl.getBoundingClientRect().height -
            overlap;
          container.style.top = `${Math.max(0, containerTop)}px`;
          alignHorizontally("center-arrow-end");
        },
      },
    };

    const calloutFits = position => {
      // Does callout element fit in this position relative
      // to the parent element without going off screen?

      // Only consider which edge of the callout the arrow points from,
      // not the alignment of the arrow along the edge of the callout
      let edgePosition = position.split("-")[0];
      return (
        positioners[edgePosition].availableSpace() >
        positioners[edgePosition].neededSpace
      );
    };

    const choosePosition = () => {
      let position = arrowPosition;
      if (!arrowPositions.includes(position)) {
        // Configured arrow position is not valid
        position = null;
      }
      if (["start", "end"].includes(position)) {
        // position here is referencing the direction that the callout container
        // is pointing to, and therefore should be the _opposite_ side of the
        // arrow eg. if arrow is at the "end" in LTR layouts, the container is
        // pointing at an element to the right of itself, while in RTL layouts
        // it is pointing to the left of itself
        position = RTL ^ (position === "start") ? "left" : "right";
      }
      // If we're overriding the position, we don't need to sort for available space
      if (customPosition || (position && calloutFits(position))) {
        return position;
      }
      let sortedPositions = ["top", "bottom", "left", "right"]
        .filter(p => p !== position)
        .filter(calloutFits)
        .sort((a, b) => {
          return (
            positioners[b].availableSpace() - positioners[b].neededSpace >
            positioners[a].availableSpace() - positioners[a].neededSpace
          );
        });
      // If the callout doesn't fit in any position, use the configured one.
      // The callout will be adjusted to overlap the parent element so that
      // the former doesn't go off screen.
      return sortedPositions[0] || position;
    };

    const centerVertically = () => {
      let topOffset =
        (container.getBoundingClientRect().height -
          parentEl.getBoundingClientRect().height) /
        2;
      container.style.top = `${getOffset(parentEl).top - topOffset}px`;
    };

    /**
     * Horizontally align a top/bottom-positioned callout according to the
     * passed position.
     * @param {String} position one of...
     *   - "center": for use with top/bottom. arrow is in the center, and the
     *       center of the callout aligns with the parent center.
     *   - "center-arrow-start": for use with center-arrow-top-start. arrow is
     *       on the start (left) side of the callout, and the callout is aligned
     *       so that the arrow points to the center of the parent element.
     *   - "center-arrow-end": for use with center-arrow-top-end. arrow is on
     *       the end, and the arrow points to the center of the parent.
     *   - "start": currently unused. align the callout's starting edge with the
     *       parent's starting edge.
     *   - "end": currently unused. same as start but for the ending edge.
     */
    const alignHorizontally = position => {
      switch (position) {
        case "center": {
          const sideOffset =
            (parentEl.getBoundingClientRect().width -
              container.getBoundingClientRect().width) /
            2;
          const containerSide = RTL
            ? doc.documentElement.clientWidth -
              getOffset(parentEl).right +
              sideOffset
            : getOffset(parentEl).left + sideOffset;
          container.style[RTL ? "right" : "left"] = `${Math.max(
            containerSide,
            0
          )}px`;
          break;
        }
        case "end":
        case "start": {
          const containerSide =
            RTL ^ (position === "end")
              ? parentEl.getBoundingClientRect().left +
                parentEl.getBoundingClientRect().width -
                container.getBoundingClientRect().width
              : parentEl.getBoundingClientRect().left;
          container.style.left = `${Math.max(containerSide, 0)}px`;
          break;
        }
        case "center-arrow-end":
        case "center-arrow-start": {
          const parentRect = parentEl.getBoundingClientRect();
          const containerWidth = container.getBoundingClientRect().width;
          const containerSide =
            RTL ^ position.endsWith("end")
              ? parentRect.left +
                parentRect.width / 2 +
                arrowWidth * 2 -
                containerWidth
              : parentRect.left + parentRect.width / 2 - arrowWidth * 2;
          const maxContainerSide =
            doc.documentElement.clientWidth - containerWidth;
          container.style.left = `${Math.min(
            maxContainerSide,
            Math.max(containerSide, 0)
          )}px`;
        }
      }
    };

    clearPosition(container);

    if (customPosition) {
      overridePosition();
    }

    let finalPosition = choosePosition();
    if (finalPosition) {
      positioners[finalPosition].position();
      addArrowPositionClassToContainer(finalPosition);
    }

    container.classList.remove("hidden");
  }

  /** Expose top level functions expected by the aboutwelcome bundle. */
  _setupWindowFunctions() {
    if (this.AWSetup) {
      return;
    }

    const AWParent = new lazy.AboutWelcomeParent();
    this.win.addEventListener("unload", () => AWParent.didDestroy());
    const receive = name => data =>
      AWParent.onContentMessage(`AWPage:${name}`, data, this.doc);

    this._windowFuncs = {
      AWGetFeatureConfig: () => this.config,
      AWGetSelectedTheme: receive("GET_SELECTED_THEME"),
      // Do not send telemetry if message config sets metrics as 'block'.
      AWSendEventTelemetry:
        this.config?.metrics !== "block" ? receive("TELEMETRY_EVENT") : null,
      AWSendToDeviceEmailsSupported: receive("SEND_TO_DEVICE_EMAILS_SUPPORTED"),
      AWSendToParent: (name, data) => receive(name)(data),
      AWFinish: () => this.endTour(),
      AWEvaluateScreenTargeting: receive("EVALUATE_SCREEN_TARGETING"),
    };
    for (const [name, func] of Object.entries(this._windowFuncs)) {
      this.win[name] = func;
    }

    this.AWSetup = true;
  }

  /** Clean up the functions defined above. */
  _clearWindowFunctions() {
    if (this.AWSetup) {
      this.AWSetup = false;

      for (const name of Object.keys(this._windowFuncs)) {
        delete this.win[name];
      }
    }
  }

  /**
   * Emit an event to the broker, if one is present.
   * @param {String} name
   * @param {any} data
   */
  _emitEvent(name, data) {
    this.listener?.(this.win, name, data);
  }

  endTour(skipFadeOut = false) {
    // We don't want focus events that happen during teardown to affect
    // this.savedActiveElement
    this.win.removeEventListener("focus", this, {
      capture: true,
      passive: true,
    });
    this.win.removeEventListener("keypress", this, { capture: true });
    this._pageEventManager?.clear();

    // Delete almost everything to get this ready to show a different message.
    this.teardownFeatureTourProgress();
    this.pref = null;
    this.ready = false;
    this.message = null;
    this.content = null;
    this.currentScreen = null;
    // wait for fade out transition
    this._container?.classList.add("hidden");
    this._clearWindowFunctions();
    this.win.setTimeout(
      () => {
        this._container?.remove();
        this.renderObserver?.disconnect();
        this._removePositionListeners();
        this.doc.querySelector(`[src="${BUNDLE_SRC}"]`)?.remove();
        // Put the focus back to the last place the user focused outside of the
        // featureCallout windows.
        if (this.savedActiveElement) {
          this.savedActiveElement.focus({ focusVisible: true });
        }
        this._emitEvent("end");
      },
      skipFadeOut ? 0 : TRANSITION_MS
    );
  }

  _dismiss() {
    let action = this.currentScreen?.content.dismiss_button?.action;
    if (action?.type) {
      this.win.AWSendToParent("SPECIAL_ACTION", action);
      if (!action.dismiss) {
        return;
      }
    }
    this.endTour();
  }

  async _addScriptsAndRender() {
    const reactSrc = "resource://activity-stream/vendor/react.js";
    const domSrc = "resource://activity-stream/vendor/react-dom.js";
    // Add React script
    const getReactReady = async () => {
      return new Promise(resolve => {
        let reactScript = this.doc.createElement("script");
        reactScript.src = reactSrc;
        this.doc.head.appendChild(reactScript);
        reactScript.addEventListener("load", resolve);
      });
    };
    // Add ReactDom script
    const getDomReady = async () => {
      return new Promise(resolve => {
        let domScript = this.doc.createElement("script");
        domScript.src = domSrc;
        this.doc.head.appendChild(domScript);
        domScript.addEventListener("load", resolve);
      });
    };
    // Load React, then React Dom
    if (!this.doc.querySelector(`[src="${reactSrc}"]`)) {
      await getReactReady();
    }
    if (!this.doc.querySelector(`[src="${domSrc}"]`)) {
      await getDomReady();
    }
    // Load the bundle to render the content as configured.
    this.doc.querySelector(`[src="${BUNDLE_SRC}"]`)?.remove();
    let bundleScript = this.doc.createElement("script");
    bundleScript.src = BUNDLE_SRC;
    this.doc.head.appendChild(bundleScript);
  }

  _observeRender(container) {
    this.renderObserver?.observe(container, { childList: true });
  }

  /**
   * Update the internal config with a new message. If a message is not
   * provided, try requesting one from ASRouter. The message content is stored
   * in this.config, which is returned by AWGetFeatureConfig. The aboutwelcome
   * bundle will use that function to get the content when it executes.
   * @param {Object} [message] ASRouter message. Omit to request a new one.
   * @returns {Promise<boolean>} true if a message is loaded, false if not.
   */
  async _updateConfig(message) {
    if (this.loadingConfig) {
      return false;
    }

    this.message = message || (await this._loadConfig());

    switch (this.message.template) {
      case "feature_callout":
        break;
      case "spotlight":
        // Special handling for spotlight messages, which can be configured as a
        // kind of introduction to a feature tour.
        this.currentScreen = "spotlight";
      // fall through
      default:
        return false;
    }

    this.config = this.message.content;

    // Set the default start screen.
    let newScreen = this.config?.screens?.[this.config?.startScreen || 0];
    // If we have a feature tour in progress, try to set the start screen to
    // whichever screen is configured in the feature tour pref.
    if (
      this.config.screens &&
      this.config?.tour_pref_name &&
      this.config.tour_pref_name === this.pref?.name &&
      this.featureTourProgress
    ) {
      const newIndex = this.config.screens.findIndex(
        screen => screen.id === this.featureTourProgress.screen
      );
      if (newIndex !== -1) {
        newScreen = this.config.screens[newIndex];
        if (newScreen?.id !== this.currentScreen?.id) {
          // This is how we tell the bundle to render the correct screen.
          this.config.startScreen = newIndex;
        }
      }
    }
    if (newScreen?.id === this.currentScreen?.id) {
      return false;
    }

    // Only add an impression if we actually have a message to impress
    if (Object.keys(this.message).length) {
      lazy.ASRouter.addImpression(this.message);
    }

    this.currentScreen = newScreen;
    return true;
  }

  /**
   * Request a message from ASRouter, targeting the `browser` and `page` values
   * passed to the constructor.
   * @returns {Promise<Object>} the requested message.
   */
  async _loadConfig() {
    this.loadingConfig = true;
    await lazy.ASRouter.waitForInitialized;
    let result = await lazy.ASRouter.sendTriggerMessage({
      browser: this.browser,
      // triggerId and triggerContext
      id: "featureCalloutCheck",
      context: { source: this.location },
    });
    this.loadingConfig = false;
    return result.message;
  }

  /**
   * Try to render the callout in the current document.
   * @returns {Promise<Boolean>} whether the callout was rendered.
   */
  async _renderCallout() {
    let container = this._createContainer();
    if (container) {
      // This results in rendering the Feature Callout
      await this._addScriptsAndRender();
      this._observeRender(container);
      this._addPositionListeners();
      return true;
    }
    return false;
  }

  /**
   * For each member of the screen's page_event_listeners array, add a listener.
   * @param {Array<PageEventListener>} listeners An array of listeners to set up
   *
   * @typedef {Object} PageEventListener
   * @property {PageEventListenerParams} params Event listener parameters
   * @property {PageEventListenerAction} action Sent when the event fires
   *
   * @typedef {Object} PageEventListenerParams See PageEventManager.sys.mjs
   * @property {String} type Event type string e.g. `click`
   * @property {String} selectors Target selector, e.g. `tag.class, #id[attr]`
   * @property {PageEventListenerOptions} [options] addEventListener options
   *
   * @typedef {Object} PageEventListenerOptions
   * @property {Boolean} [capture] Use event capturing phase?
   * @property {Boolean} [once] Remove listener after first event?
   * @property {Boolean} [preventDefault] Prevent default action?
   *
   * @typedef {Object} PageEventListenerAction Action sent to AboutWelcomeParent
   * @property {String} [type] Action type, e.g. `OPEN_URL`
   * @property {Object} [data] Extra data, properties depend on action type
   * @property {Boolean} [dismiss] Dismiss screen after performing action?
   */
  _attachPageEventListeners(listeners) {
    listeners?.forEach(({ params, action }) =>
      this._loadPageEventManager[params.options?.once ? "once" : "on"](
        params,
        event => {
          this._handlePageEventAction(action, event);
          if (params.options?.preventDefault) {
            event.preventDefault?.();
          }
        }
      )
    );
  }

  /**
   * Perform an action in response to a page event.
   * @param {PageEventListenerAction} action
   * @param {Event} event Triggering event
   */
  _handlePageEventAction(action, event) {
    const page = this.location;
    const message_id = this.config?.id.toUpperCase();
    const source = this._getUniqueElementIdentifier(event.target);
    this.win.AWSendEventTelemetry?.({
      event: "PAGE_EVENT",
      event_context: {
        action: action.type ?? (action.dismiss ? "DISMISS" : ""),
        reason: event.type?.toUpperCase(),
        source,
        page,
      },
      message_id,
    });
    if (action.type) {
      this.win.AWSendToParent("SPECIAL_ACTION", action);
    }
    if (action.dismiss) {
      this.win.AWSendEventTelemetry?.({
        event: "DISMISS",
        event_context: { source: `PAGE_EVENT:${source}`, page },
        message_id,
      });
      this._dismiss();
    }
  }

  /**
   * For a given element, calculate a unique string that identifies it.
   * @param {Element} target Element to calculate the selector for
   * @returns {String} Computed event target selector, e.g. `button#next`
   */
  _getUniqueElementIdentifier(target) {
    let source;
    if (Element.isInstance(target)) {
      source = target.localName;
      if (target.className) {
        source += `.${[...target.classList].join(".")}`;
      }
      if (target.id) {
        source += `#${target.id}`;
      }
      if (target.attributes.length) {
        source += `${[...target.attributes]
          .filter(attr => ["is", "role", "open"].includes(attr.name))
          .map(attr => `[${attr.name}="${attr.value}"]`)
          .join("")}`;
      }
      if (this.doc.querySelectorAll(source).length > 1) {
        let uniqueAncestor = target.closest(`[id]:not(:scope, :root, body)`);
        if (uniqueAncestor) {
          source = `${this._getUniqueElementIdentifier(
            uniqueAncestor
          )} > ${source}`;
        }
      }
    }
    return source;
  }

  /**
   * Show a feature callout message, either by requesting one from ASRouter or
   * by showing a message passed as an argument.
   * @param {Object} [message] optional message to show instead of requesting one
   * @returns {Promise<Boolean>} true if a message was shown
   */
  async showFeatureCallout(message) {
    let updated = await this._updateConfig(message);

    if (!updated || !this.config?.screens?.length) {
      return !!this.currentScreen;
    }

    this.renderObserver = new this.win.MutationObserver(() => {
      // Check if the Feature Callout screen has loaded for the first time
      if (!this.ready && this._container.querySelector(".screen")) {
        // Once the screen element is added to the DOM, wait for the
        // animation frame after next to ensure that _positionCallout
        // has access to the rendered screen with the correct height
        this.win.requestAnimationFrame(() => {
          this.win.requestAnimationFrame(() => {
            this.ready = true;
            this._attachPageEventListeners(
              this.currentScreen?.content?.page_event_listeners
            );
            this.win.addEventListener("keypress", this, { capture: true });
            this._positionCallout();
            let button = this._container.querySelector(".primary");
            button.focus();
            this.win.addEventListener("focus", this, {
              capture: true, // get the event before retargeting
              passive: true,
            });
          });
        });
      }
    });

    this._pageEventManager?.clear();
    this.ready = false;
    this._container?.remove();

    if (!this.cfrFeaturesUserPref) {
      this.endTour();
      return false;
    }

    this._addCalloutLinkElements();
    this._setupWindowFunctions();
    let rendering = await this._renderCallout();
    return rendering && !!this.currentScreen;
  }

  /**
   * @typedef {Object} FeatureCalloutTheme An object with a set of custom color
   *   schemes and/or a preset key. If both are provided, the preset will be
   *   applied first, then the custom themes will override the preset values.
   * @property {String} [preset] Key of {@link FeatureCallout.themePresets}
   * @property {ColorScheme} [light] Custom light scheme
   * @property {ColorScheme} [dark] Custom dark scheme
   * @property {ColorScheme} [hcm] Custom high contrast scheme
   * @property {ColorScheme} [all] Custom scheme that will be applied in all
   *   cases, but overridden by the other schemes if they are present. This is
   *   useful if the values are already controlled by the browser theme.
   * @property {Boolean} [simulateContent] Set to true if the feature callout
   *   exists in the browser chrome but is meant to be displayed over the
   *   content area to appear as if it is part of the page. This will cause the
   *   styles to use a media query targeting the content instead of the chrome,
   *   so that if the browser theme doesn't match the content color scheme, the
   *   callout will correctly follow the content scheme. This is currently used
   *   for the feature callouts displayed over the PDF.js viewer.
   */

  /**
   * @typedef {Object} ColorScheme An object with key-value pairs, with keys
   *   from {@link FeatureCallout.themePropNames}, mapped to CSS color values
   */

  /**
   * Combine the preset and custom themes into a single object and store it.
   * @param {FeatureCalloutTheme} theme
   */
  _initTheme(theme) {
    /** @type {FeatureCalloutTheme} */
    this.theme = Object.assign(
      {},
      FeatureCallout.themePresets[theme.preset],
      theme
    );
  }

  /**
   * Apply all the theme colors to the feature callout's root element as CSS
   * custom properties in inline styles. These custom properties are consumed by
   * _feature-callout-theme.scss, which is bundled with the other styles that
   * are loaded by {@link FeatureCallout.prototype._addCalloutLinkElements}.
   */
  _applyTheme() {
    if (this._container) {
      // This tells the stylesheets to use -moz-content-prefers-color-scheme
      // instead of prefers-color-scheme, in order to follow the content color
      // scheme instead of the chrome color scheme, in case of a mismatch when
      // the feature callout exists in the chrome but is meant to look like it's
      // part of the content of a page in a browser tab (like PDF.js).
      this._container.classList.toggle(
        "simulateContent",
        !!this.theme.simulateContent
      );
      for (const type of ["light", "dark", "hcm"]) {
        const scheme = this.theme[type];
        for (const name of FeatureCallout.themePropNames) {
          this._setThemeVariable(
            `--fc-${name}-${type}`,
            scheme?.[name] || this.theme.all?.[name]
          );
        }
      }
    }
  }

  /**
   * Set or remove a CSS custom property on the feature callout container
   * @param {String} name Name of the CSS custom property
   * @param {String|void} [value] Value of the property, or omit to remove it
   */
  _setThemeVariable(name, value) {
    if (value) {
      this._container.style.setProperty(name, value);
    } else {
      this._container.style.removeProperty(name);
    }
  }

  /** A list of all the theme properties that can be set */
  static themePropNames = [
    "background",
    "color",
    "border",
    "accent-color",
    "button-background",
    "button-color",
    "button-border",
    "button-background-hover",
    "button-color-hover",
    "button-border-hover",
    "button-background-active",
    "button-color-active",
    "button-border-active",
  ];

  /** @type {Object<String, FeatureCalloutTheme>} */
  static themePresets = {
    // For themed system pages like New Tab and Firefox View. Themed content
    // colors inherit from the user's theme through contentTheme.js.
    "themed-content": {
      all: {
        background: "var(--newtab-background-color-secondary)",
        color: "var(--newtab-text-primary-color, var(--in-content-page-color))",
        border:
          "color-mix(in srgb, var(--newtab-background-color-secondary) 80%, #000)",
        "accent-color": "var(--in-content-primary-button-background)",
        "button-background": "color-mix(in srgb, transparent 93%, #000)",
        "button-color":
          "var(--newtab-text-primary-color, var(--in-content-page-color))",
        "button-border": "transparent",
        "button-background-hover": "color-mix(in srgb, transparent 88%, #000)",
        "button-color-hover":
          "var(--newtab-text-primary-color, var(--in-content-page-color))",
        "button-border-hover": "transparent",
        "button-background-active": "color-mix(in srgb, transparent 80%, #000)",
        "button-color-active":
          "var(--newtab-text-primary-color, var(--in-content-page-color))",
        "button-border-active": "transparent",
      },
      dark: {
        border:
          "color-mix(in srgb, var(--newtab-background-color-secondary) 80%, #FFF)",
        "button-background": "color-mix(in srgb, transparent 80%, #000)",
        "button-background-hover": "color-mix(in srgb, transparent 65%, #000)",
        "button-background-active": "color-mix(in srgb, transparent 55%, #000)",
      },
      hcm: {
        background: "-moz-dialog",
        color: "-moz-dialogtext",
        border: "-moz-dialogtext",
        "accent-color": "LinkText",
        "button-background": "ButtonFace",
        "button-color": "ButtonText",
        "button-border": "ButtonText",
        "button-background-hover": "ButtonText",
        "button-color-hover": "ButtonFace",
        "button-border-hover": "ButtonText",
        "button-background-active": "ButtonText",
        "button-color-active": "ButtonFace",
        "button-border-active": "ButtonText",
      },
    },
    // PDF.js colors are from toolkit/components/pdfjs/content/web/viewer.css
    pdfjs: {
      all: {
        background: "#FFF",
        color: "rgb(12, 12, 13)",
        border: "#CFCFD8",
        "accent-color": "#0A84FF",
        "button-background": "rgb(215, 215, 219)",
        "button-color": "rgb(12, 12, 13)",
        "button-border": "transparent",
        "button-background-hover": "rgb(221, 222, 223)",
        "button-color-hover": "rgb(12, 12, 13)",
        "button-border-hover": "transparent",
        "button-background-active": "rgb(221, 222, 223)",
        "button-color-active": "rgb(12, 12, 13)",
        "button-border-active": "transparent",
      },
      dark: {
        background: "#1C1B22",
        color: "#F9F9FA",
        border: "#3A3944",
        "button-background": "rgb(74, 74, 79)",
        "button-color": "#F9F9FA",
        "button-background-hover": "rgb(102, 102, 103)",
        "button-color-hover": "#F9F9FA",
        "button-background-active": "rgb(102, 102, 103)",
        "button-color-active": "#F9F9FA",
      },
      hcm: {
        background: "-moz-dialog",
        color: "-moz-dialogtext",
        border: "CanvasText",
        "accent-color": "Highlight",
        "button-background": "ButtonFace",
        "button-color": "ButtonText",
        "button-border": "ButtonText",
        "button-background-hover": "Highlight",
        "button-color-hover": "CanvasText",
        "button-border-hover": "Highlight",
        "button-background-active": "Highlight",
        "button-color-active": "CanvasText",
        "button-border-active": "Highlight",
      },
    },
    newtab: {
      all: {
        background: "var(--newtab-background-color-secondary, #FFF)",
        color: "var(--newtab-text-primary-color, WindowText)",
        border:
          "color-mix(in srgb, var(--newtab-background-color-secondary, #FFF) 80%, #000)",
        "accent-color": "SelectedItem",
        "button-background": "color-mix(in srgb, transparent 93%, #000)",
        "button-color": "var(--newtab-text-primary-color, WindowText)",
        "button-border": "transparent",
        "button-background-hover": "color-mix(in srgb, transparent 88%, #000)",
        "button-color-hover": "var(--newtab-text-primary-color, WindowText)",
        "button-border-hover": "transparent",
        "button-background-active": "color-mix(in srgb, transparent 80%, #000)",
        "button-color-active": "var(--newtab-text-primary-color, WindowText)",
        "button-border-active": "transparent",
      },
      dark: {
        background: "var(--newtab-background-color-secondary, #42414D)",
        border:
          "color-mix(in srgb, var(--newtab-background-color-secondary, #42414D) 80%, #FFF)",
        "button-background": "color-mix(in srgb, transparent 80%, #000)",
        "button-background-hover": "color-mix(in srgb, transparent 65%, #000)",
        "button-background-active": "color-mix(in srgb, transparent 55%, #000)",
      },
      hcm: {
        background: "-moz-dialog",
        color: "-moz-dialogtext",
        border: "-moz-dialogtext",
        "accent-color": "LinkText",
        "button-background": "ButtonFace",
        "button-color": "ButtonText",
        "button-border": "ButtonText",
        "button-background-hover": "ButtonText",
        "button-color-hover": "ButtonFace",
        "button-border-hover": "ButtonText",
        "button-background-active": "ButtonText",
        "button-color-active": "ButtonFace",
        "button-border-active": "ButtonText",
      },
    },
    // These colors are intended to inherit the user's theme properties from the
    // main chrome window, for callouts to be anchored to chrome elements.
    // Specific schemes aren't necessary since the theme and frontend
    // stylesheets handle these variables' values.
    chrome: {
      all: {
        background: "var(--arrowpanel-background)",
        color: "var(--arrowpanel-color)",
        border: "var(--arrowpanel-border-color)",
        "accent-color": "var(--focus-outline-color)",
        "button-background": "var(--button-bgcolor)",
        "button-color": "var(--arrowpanel-color)",
        "button-border": "transparent",
        "button-background-hover": "var(--button-hover-bgcolor)",
        "button-color-hover": "var(--arrowpanel-color)",
        "button-border-hover": "transparent",
        "button-background-active": "var(--button-active-bgcolor)",
        "button-color-active": "var(--arrowpanel-color)",
        "button-border-active": "transparent",
      },
    },
  };
}
