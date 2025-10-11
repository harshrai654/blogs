(() => {
  // ns-hugo-params:/Users/harshrai/Library/Caches/hugo_cache/modules/filecache/modules/pkg/mod/github.com/hugomods/code-block-panel@v0.9.0/assets/mods/code-block-panel/js/panel.ts
  var panel_default = { defaultLang: "en", expand: false, i18n: { en: { copied: { other: "Copied!" }, copy_failed: { other: "Copy failed!" } } }, icons: { copy: "", expand: "", ln: "", wrap: "" }, line_nos: true, max_lines: 10, wrap: true };

  // ns-hugo-imp:/Users/harshrai/Library/Caches/hugo_cache/modules/filecache/modules/pkg/mod/github.com/hugomods/snackbar@v0.1.2/assets/mods/snackbar/js/index.ts
  var Snackbar = class {
    container;
    constructor() {
      this.container = document.createElement("div");
      this.container.className = "snackbars";
      document.body.appendChild(this.container);
    }
    add(text, duration = 2e3) {
      const msg = document.createElement("div");
      msg.className = "snackbar";
      msg.innerText = text;
      this.container.appendChild(msg);
      setTimeout(() => {
        msg.remove();
      }, duration);
    }
  };
  var snackbar = new Snackbar();
  var js_default = snackbar;

  // ns-hugo-params:/Users/harshrai/Library/Caches/hugo_cache/modules/filecache/modules/pkg/mod/github.com/hugomods/code-block-panel@v0.9.0/assets/mods/code-block-panel/js/i18n.ts
  var i18n_default = { defaultLang: "en", expand: false, i18n: { en: { copied: { other: "Copied!" }, copy_failed: { other: "Copy failed!" } } }, icons: { copy: "", expand: "", ln: "", wrap: "" }, line_nos: true, max_lines: 10, wrap: true };

  // ns-hugo-imp:/Users/harshrai/Library/Caches/hugo_cache/modules/filecache/modules/pkg/mod/github.com/hugomods/i18n-js@v0.2.1/assets/mods/i18n/translator.ts
  var Translator = class {
    constructor(translations, fallback) {
      this.translations = translations;
      this.fallback = fallback;
    }
    lang = "";
    getLang() {
      if (this.lang === "") {
        this.lang = document.documentElement.getAttribute("lang") ?? this.fallback;
      }
      return this.lang;
    }
    getTranslations() {
      const lang = this.getLang();
      return this.translations[lang] ?? this.getFallbackTranslations();
    }
    getFallbackTranslations() {
      return this.translations[this.fallback];
    }
    getFallbackTranslation(key) {
      const translations = this.getFallbackTranslations();
      return translations[key] ?? "";
    }
    translate(key, ctx, fallback = "") {
      const translations = this.getTranslations();
      if (!translations) {
        return fallback === "" ? key : fallback;
      }
      const translation = translations[key] ?? this.getFallbackTranslation(key);
      if (!translation) {
        return fallback === "" ? key : fallback;
      }
      if (!ctx) {
        return translation.other;
      }
      let format = ctx.count === 1 ? translation.one : translation.other;
      for (let name in ctx) {
        format = format.replace(`{${name}}`, ctx[name]);
      }
      return format;
    }
  };

  // ns-hugo-imp:/Users/harshrai/Library/Caches/hugo_cache/modules/filecache/modules/pkg/mod/github.com/hugomods/code-block-panel@v0.9.0/assets/mods/code-block-panel/js/i18n.ts
  var i18n = new Translator(i18n_default.i18n, i18n_default.defaultLang);
  var i18n_default2 = i18n;

  // ns-hugo-imp:/Users/harshrai/Library/Caches/hugo_cache/modules/filecache/modules/pkg/mod/github.com/hugomods/code-block-panel@v0.9.0/assets/mods/code-block-panel/js/panel.ts
  var isTrue = (val) => {
    if (typeof val === "boolean") {
      return val;
    }
    return val !== "" && val !== "false" && val !== "0";
  };
  var Panel = class {
    constructor(code) {
      this.code = code;
    }
    highlight;
    pre;
    wrapper;
    ele;
    init() {
      const highlight = this.code.closest(".highlight");
      if (!isTrue(highlight?.getAttribute("data-line-nos") ?? panel_default.line_nos)) {
        this.code.classList.add("code-no-ln");
      }
      if (isTrue(highlight?.getAttribute("data-wrap") ?? panel_default.wrap)) {
        this.code.classList.add("code-wrap");
      }
      if (isTrue(highlight?.getAttribute("data-expand") ?? panel_default.expand)) {
        this.expand();
      }
      this.pre = this.code.parentElement;
      this.highlight = this.pre.parentElement;
      this.ele = document.createElement("div");
      this.ele.className = "code-block-panel";
      this.wrapper = document.createElement("div");
      this.wrapper.className = "code-block-panel-wrapper";
      this.wrapper.appendChild(this.ele);
      this.maxLines();
      this.title();
      this.lineNoButton();
      this.wrapButton();
      this.expandButton();
      this.copyButton();
      this.pre.appendChild(this.wrapper);
    }
    // Returns the lines of code block.
    lines() {
      return Array.from(this.code.querySelectorAll(":scope > span"));
    }
    maxHeight;
    maxLines() {
      const lines = this.lines();
      const maxLines = this.code.closest(".highlight")?.getAttribute("data-max-lines") ?? panel_default.max_lines;
      if (maxLines > 0 && lines.length > maxLines) {
        const offsetTop = lines[maxLines].offsetTop;
        if (offsetTop > 0) {
          this.pre.style.maxHeight = this.maxHeight = offsetTop + "px";
        }
      }
    }
    // Display the title
    title() {
      const title = this.highlight.getAttribute("title");
      if (title === null) {
        return;
      }
      this.code.setAttribute("title", title);
    }
    button(name, callback) {
      const btn = document.createElement("button");
      btn.className = "code-block-action code-block-action-" + name;
      btn.innerHTML = panel_default.icons[name];
      btn.addEventListener("click", () => {
        callback();
      });
      return btn;
    }
    copyButton() {
      const btn = this.button("copy", () => {
        this.copy();
      });
      this.ele.appendChild(btn);
    }
    copy() {
      const clone = this.code.cloneNode(true);
      clone.querySelectorAll(".ln, :scope > span > span:first-child").forEach((ln) => {
        ln.remove();
      });
      navigator.clipboard.writeText(clone.innerText).then(() => {
        js_default.add(i18n_default2.translate("copied", null, "Copied!"));
      }).catch((err) => {
        js_default.add(i18n_default2.translate("copy_failed", null, "Copy failed."));
        console.error(err);
      });
    }
    wrapButton() {
      const btn = this.button("wrap", () => {
        this.toggleClass("code-wrap");
      });
      this.ele.appendChild(btn);
    }
    toggleClass(className) {
      if (this.code.classList.contains(className)) {
        this.code.classList.remove(className);
        return;
      }
      this.code.classList.add(className);
    }
    lineNoButton() {
      const btn = this.button("ln", () => {
        this.toggleClass("code-no-ln");
      });
      this.ele.appendChild(btn);
    }
    expandButton() {
      const btn = this.button("expand", () => {
        this.expand();
      });
      this.ele.appendChild(btn);
    }
    expand() {
      if (!this.pre.style.maxHeight && !this.maxHeight) {
        return;
      }
      if (this.pre.style.maxHeight) {
        this.pre.style.maxHeight = "";
        return;
      }
      this.pre.style.maxHeight = this.maxHeight;
    }
  };

  // <stdin>
  (() => {
    "use strict";
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("pre code").forEach((code) => {
        new Panel(code).init();
      });
    });
  })();
})();
