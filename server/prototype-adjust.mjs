// Quick adjustments for a Servant prototype page. Served at /p/_servant/adjust.js
// and added to a prototype page only when it's opened with ?servant-adjust=1.
// This module exports the script's source (deployed releases include only .mjs files).
//
// It lets the page that embeds this prototype (the Servant app) pick elements
// and preview changes to their text, styles and layout, in this browser only.
// Nothing is saved: the app turns the changes into a request for the agent (or
// a review suggestion), and the agent changes the prototype's source.
//
// It talks only to the embedding window, through postMessage. It reads nothing
// outside this page and sends nothing anywhere else.
export const ADJUST_SCRIPT = String.raw`(function () {
  "use strict";
  if (window.__servantAdjust || window.parent === window) return;
  window.__servantAdjust = true;
  var host = window.parent;
  var FROM = "servant-adjust", TO = "servant-adjust-cmd";
  var STYLES = ["color", "background-color", "font-size", "font-weight", "text-align", "padding", "margin", "border-radius", "width", "height"];
  var SAFE_VALUE = /^[#%(),.\s\w-]{0,60}$/;
  var picking = false, selected = null, nextId = 1;
  var elements = {};           // id -> element
  var originals = [];          // { el, kind, prop, value } restored by reset, newest first
  var moves = [];              // { el, parent, next } restored by reset, newest first
  var editing = null;          // { el, before } while text is edited on the page
  // Changes for one screen size only go in this sheet as @media rules; a reset empties it.
  var scoped = document.createElement("style");
  scoped.setAttribute("data-servant-adjust", "");
  var MEDIA = { phone: "(max-width: 599.98px)", tablet: "(min-width: 600px) and (max-width: 1023.98px)", desktop: "(min-width: 1024px)" };

  function marker(el) { return el && el.hasAttribute && el.hasAttribute("data-servant-adjust"); }
  function box(color, width) {
    var b = document.createElement("div");
    b.setAttribute("data-servant-adjust", "");
    b.setAttribute("aria-hidden", "true");
    b.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;display:none;box-sizing:border-box;border:" + width + "px solid " + color + ";border-radius:2px";
    return b;
  }
  var hoverBox = box("rgba(26,115,232,.55)", 1), selectBox = box("#1a73e8", 2);
  function attach() { if (document.body && !hoverBox.parentNode) { document.body.appendChild(hoverBox); document.body.appendChild(selectBox); (document.head || document.body).appendChild(scoped); } }
  function place(b, el) {
    if (!el || !document.contains(el)) { b.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    b.style.display = "block"; b.style.left = r.left + "px"; b.style.top = r.top + "px"; b.style.width = r.width + "px"; b.style.height = r.height + "px";
  }

  // How each element looked when first seen, before any change: the agent finds it in the source by these.
  var firstLabel = {}, firstPath = {}, firstLook = {};
  function idOf(el) {
    var id = el.getAttribute("data-servant-adjust-id");
    if (!id) {
      id = "e" + nextId++;
      el.setAttribute("data-servant-adjust-id", id);
      firstLabel[id] = currentLabel(el);
      firstPath[id] = pathOf(el);
    }
    elements[id] = el;
    return id;
  }
  // A readable CSS path from <body>: #id when it's unique, otherwise tag:nth-of-type steps.
  function pathOf(el) {
    var steps = [];
    for (var node = el; node && node.nodeType === 1 && node !== document.body && steps.length < 8; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll("#" + node.id).length === 1) { steps.unshift("#" + node.id); return steps.join(" > "); }
      var tag = node.tagName.toLowerCase(), n = 1;
      for (var sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === node.tagName) n++;
      steps.unshift(tag + ":nth-of-type(" + n + ")");
    }
    return steps.join(" > ") || "body";
  }
  function clean(text, limit) { return String(text || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit); }
  function labelOf(el) { return firstLabel[idOf(el)]; }
  // Areas that hold other elements (main, sections, lists, plain boxes) are named by their own
  // label or id only: their text would run every child's words together.
  var CONTAINERS = /^(main|section|article|aside|nav|header|footer|form|ul|ol|table|tbody|thead|tr|div|body|fieldset|figure)$/i;
  function currentLabel(el) {
    var named = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder");
    if (named) return clean(named, 60);
    if (CONTAINERS.test(el.tagName) && el.firstElementChild) return el.id && /^[A-Za-z][\w-]*$/.test(el.id) ? "#" + el.id : "";
    return clean(el.textContent || "", 60);
  }
  var KIND = { h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", h5: "Heading", h6: "Heading", p: "Paragraph", a: "Link", button: "Button", img: "Image", input: "Field", select: "Menu", textarea: "Field", label: "Label", li: "List item", ul: "List", ol: "List", nav: "Navigation", header: "Header", footer: "Footer", main: "Main area", section: "Section", form: "Form", table: "Table", span: "Text", strong: "Text", em: "Text", small: "Text" };
  function textEditable(el) { return el.children.length === 0 && !/^(input|select|textarea|img|svg|video|iframe|script|style)$/i.test(el.tagName); }
  function visibleSibling(el, dir) {
    for (var s = dir < 0 ? el.previousElementSibling : el.nextElementSibling; s; s = dir < 0 ? s.previousElementSibling : s.nextElementSibling) {
      if (!marker(s) && !/^(script|style|template)$/i.test(s.tagName)) return s;
    }
    return null;
  }
  function firstChild(el) { for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (!marker(c) && !/^(script|style|template)$/i.test(c.tagName)) return c; return null; }
  // The page's own style rules (same-origin sheets only), applying the ones whose media matches.
  function eachRule(fn) {
    function walk(rules) {
      for (var i = 0; rules && i < rules.length; i++) {
        var rule = rules[i];
        if (rule.cssRules && rule.media) { if (window.matchMedia(rule.media.mediaText).matches) walk(rule.cssRules); }
        else if (rule.selectorText && rule.style) fn(rule);
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet = document.styleSheets[i];
      if (sheet.ownerNode === scoped) continue;
      try { walk(sheet.cssRules); } catch (e) { /* another site's sheet: not readable, skipped */ }
    }
  }
  function matches(el, selector) { try { return el.matches(selector); } catch (e) { return false; } }
  // The value the page's CSS sets for a property on this element (inline first), or "" when nothing sets it.
  function authored(el, prop) {
    var inline = el.style.getPropertyValue(prop);
    if (inline) return inline;
    var found = "";
    eachRule(function (rule) { var v = rule.style.getPropertyValue(prop); if (v && matches(el, rule.selectorText)) found = v; });
    return found;
  }
  // The design kit: custom properties the page defines on :root or html.
  function tokens() {
    var names = [], seen = {}, root = getComputedStyle(document.documentElement);
    eachRule(function (rule) {
      if (!/^\s*(:root|html)\s*(,\s*(:root|html)\s*)*$/i.test(rule.selectorText)) return;
      for (var i = 0; i < rule.style.length && names.length < 60; i++) {
        var name = rule.style[i];
        if (/^--[A-Za-z0-9_-]{1,40}$/.test(name) && !seen[name]) { seen[name] = true; names.push({ name: name, value: clean(root.getPropertyValue(name), 60) }); }
      }
    });
    return names;
  }
  // The color actually behind an element's text: the nearest background that isn't see-through.
  function backdrop(el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      var bg = getComputedStyle(node).backgroundColor;
      if (bg && !/^(transparent|rgba\([^)]*,\s*0\))$/.test(bg)) return clean(bg, 60);
    }
    return "rgb(255, 255, 255)";
  }
  function describe(el) {
    var cs = getComputedStyle(el), styles = {}, kit = {};
    for (var i = 0; i < STYLES.length; i++) {
      var prop = STYLES[i], own = authored(el, prop);
      // Sizes nobody set read as "auto", not as whatever they worked out to.
      styles[prop] = clean((prop === "width" || prop === "height") ? (own && !/var\(/.test(own) ? own : own ? cs.getPropertyValue(prop) : "auto") : cs.getPropertyValue(prop), 60);
      var token = own.match(/^\s*var\((--[A-Za-z0-9_-]{1,40})\)\s*$/);
      if (token) kit[prop] = token[1];
    }
    var prev = visibleSibling(el, -1), next = visibleSibling(el, 1), id = idOf(el);
    // How it looked when first described, before any change to it: changes are measured from this.
    if (!firstLook[id]) {
      var copy = {};
      for (var k = 0; k < STYLES.length; k++) copy[STYLES[k]] = styles[STYLES[k]];
      firstLook[id] = { text: textEditable(el) ? clean(el.textContent, 2000) : null, styles: copy, hidden: el.style.display === "none" };
    }
    return {
      original: firstLook[id],
      id: idOf(el), tag: el.tagName.toLowerCase(), kind: KIND[el.tagName.toLowerCase()] || "Element", label: labelOf(el), path: firstPath[idOf(el)],
      text: textEditable(el) ? clean(el.textContent, 2000) : null, styles: styles, tokens: kit, backdrop: backdrop(el), hidden: el.style.display === "none",
      previous: prev ? { id: idOf(prev), label: labelOf(prev), kind: KIND[prev.tagName.toLowerCase()] || "Element" } : null,
      next: next ? { id: idOf(next), label: labelOf(next), kind: KIND[next.tagName.toLowerCase()] || "Element" } : null,
      hasParent: !!el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement,
      hasChildren: !!firstChild(el),
    };
  }
  function post(type, extra) {
    var message = { source: FROM, version: 1, type: type };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) message[k] = extra[k];
    host.postMessage(message, "*");
  }
  function select(el) {
    if (!el || el === document.body || el === document.documentElement || marker(el)) return;
    selected = el;
    place(selectBox, el);
    post("selected", { element: describe(el) });
  }

  // Remember how something looked before its first change, so a reset can restore it.
  function remember(el, kind, prop) {
    for (var i = 0; i < originals.length; i++) if (originals[i].el === el && originals[i].kind === kind && originals[i].prop === prop) return;
    originals.unshift({ el: el, kind: kind, prop: prop, value: kind === "text" ? el.textContent : el.style.getPropertyValue(prop) });
  }
  function reset() {
    for (var i = 0; i < moves.length; i++) { var m = moves[i]; if (m.parent && document.contains(m.parent)) m.parent.insertBefore(m.el, m.next && m.next.parentNode === m.parent ? m.next : null); }
    moves = [];
    for (var j = 0; j < originals.length; j++) {
      var o = originals[j];
      if (o.kind === "text") o.el.textContent = o.value;
      else if (o.value) o.el.style.setProperty(o.prop, o.value); else o.el.style.removeProperty(o.prop);
    }
    originals = [];
    scoped.textContent = "";
  }
  function safe(value) { return typeof value === "string" && SAFE_VALUE.test(value) && !/url\s*\(|expression/i.test(value); }
  // One change: { id, prop, value, scope? }. prop is "text", a style from STYLES, "hidden" or "move".
  // A scope (phone, tablet or desktop) applies a style or hide at that screen size only.
  function apply(change) {
    var el = elements[change && change.id];
    if (!el || !document.contains(el)) return false;
    var prop = String(change.prop || ""), value = change.value;
    if (change.scope !== undefined) {
      var media = MEDIA[change.scope];
      if (!media || !(STYLES.indexOf(prop) >= 0 || prop === "hidden")) return false;
      if (prop === "hidden" ? typeof value !== "boolean" : !safe(value)) return false;
      var decl = prop === "hidden" ? (value ? "display:none !important" : "") : prop + ":" + value + " !important";
      if (decl) scoped.textContent += "@media " + media + "{[data-servant-adjust-id=\"" + change.id + "\"]{" + decl + "}}\n";
      return true;
    }
    if (prop === "text") {
      if (!textEditable(el) || typeof value !== "string" || value.length > 2000) return false;
      remember(el, "text", "text"); el.textContent = value; return true;
    }
    if (prop === "hidden") { remember(el, "style", "display"); if (value === true) el.style.setProperty("display", "none"); else el.style.removeProperty("display"); return true; }
    if (prop === "move") {
      var target = visibleSibling(el, value === "earlier" ? -1 : 1);
      if (!target) return false;
      moves.unshift({ el: el, parent: el.parentNode, next: el.nextSibling });
      el.parentNode.insertBefore(el, value === "earlier" ? target : target.nextSibling);
      return true;
    }
    if (STYLES.indexOf(prop) < 0 || !safe(value)) return false;
    remember(el, "style", prop); el.style.setProperty(prop, value); return true;
  }

  // Text edited right on the page (double-click, or the app's Edit on page). The page goes back
  // as it was; the app records the new text as a change and replays it.
  function startEditing(el) {
    if (!el || !textEditable(el) || editing) return;
    select(el);
    editing = { el: el, before: el.textContent };
    el.setAttribute("contenteditable", "plaintext-only");
    if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
    el.focus();
    var range = document.createRange(); range.selectNodeContents(el);
    var sel = window.getSelection(); if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    post("editing", { on: true });
  }
  function stopEditing(keep) {
    if (!editing) return;
    var el = editing.el, text = clean(el.innerText !== undefined ? el.innerText : el.textContent, 2000);
    el.removeAttribute("contenteditable");
    el.textContent = editing.before;
    editing = null;
    post("editing", { on: false });
    if (keep) post("edited", { element: describe(el), text: text });
  }
  document.addEventListener("dblclick", function (event) {
    if (!picking || marker(event.target)) return;
    event.preventDefault(); event.stopPropagation();
    startEditing(event.target);
  }, true);
  document.addEventListener("focusout", function (event) { if (editing && event.target === editing.el) stopEditing(true); }, true);

  // What a quick accessibility check finds: things a person can't perceive or use. Text colors are
  // sent along as they are; the app works out contrast.
  function shown(el) { var r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; }
  function nameOf(el) {
    var by = el.getAttribute("aria-labelledby");
    if (by) { var text = by.split(/\s+/).map(function (id) { var t = document.getElementById(id); return t ? t.textContent : ""; }).join(" "); if (clean(text, 60)) return clean(text, 60); }
    var alt = ""; var imgs = el.querySelectorAll ? el.querySelectorAll("img[alt]") : [];
    for (var i = 0; i < imgs.length; i++) alt += " " + imgs[i].getAttribute("alt");
    return clean(el.getAttribute("aria-label") || el.textContent || alt || el.getAttribute("title") || el.getAttribute("value") || "", 60);
  }
  function fieldLabel(el) {
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")) return true;
    if (el.closest("label")) return true;
    return !!(el.id && document.querySelector("label[for=\"" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + "\"]"));
  }
  function scan() {
    var issues = [], texts = [], all = document.body.querySelectorAll("*");
    function add(el, problem) { if (issues.length < 60) issues.push({ id: el ? idOf(el) : null, kind: el ? KIND[el.tagName.toLowerCase()] || "Element" : "Page", label: el ? labelOf(el) : "", problem: problem }); }
    if (!clean(document.documentElement.getAttribute("lang"), 20)) add(null, "no-lang");
    var level = 0, h1 = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i], tag = el.tagName.toLowerCase();
      if (marker(el) || /^(script|style|template|noscript)$/.test(tag) || !shown(el)) continue;
      var heading = tag.match(/^h([1-6])$/);
      if (heading) { var n = Number(heading[1]); if (n === 1) h1++; if (level && n > level + 1) add(el, "heading-skip"); level = n; }
      if (tag === "img" && !el.hasAttribute("alt")) add(el, "no-alt");
      var role = el.getAttribute("role");
      if ((tag === "button" || (tag === "a" && el.hasAttribute("href")) || role === "button" || role === "link") && !nameOf(el)) add(el, "no-name");
      if ((tag === "select" || tag === "textarea" || (tag === "input" && !/^(hidden|submit|button|reset|image)$/i.test(el.type))) && !fieldLabel(el)) add(el, "no-label");
      if ((tag === "button" || tag === "input" || tag === "select" || (tag === "a" && !el.closest("p, li"))) && el.type !== "hidden") {
        var r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) add(el, "small-target");
      }
      var own = "";
      for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
      if (clean(own, 10) && texts.length < 200) {
        var cs = getComputedStyle(el);
        texts.push({ id: idOf(el), kind: KIND[tag] || "Element", label: labelOf(el), color: clean(cs.color, 60), backdrop: backdrop(el), size: clean(cs.fontSize, 20), weight: clean(cs.fontWeight, 10) });
      }
    }
    if (!h1) add(null, "no-h1");
    return { issues: issues, texts: texts };
  }
  // The page's outline, for picking things that are hard to click.
  function layers() {
    var items = [];
    function walk(el, depth) {
      for (var c = el.firstElementChild; c && items.length < 150; c = c.nextElementSibling) {
        if (marker(c) || /^(script|style|template|noscript|br)$/i.test(c.tagName)) continue;
        items.push({ id: idOf(c), kind: KIND[c.tagName.toLowerCase()] || "Element", label: labelOf(c), depth: depth, hidden: !shown(c) });
        if (depth < 6) walk(c, depth + 1);
      }
    }
    walk(document.body, 0);
    return items;
  }

  document.addEventListener("mousemove", function (event) { if (picking && !marker(event.target)) place(hoverBox, event.target); }, true);
  document.addEventListener("click", function (event) {
    if (!picking || (editing && editing.el.contains(event.target))) return;
    event.preventDefault(); event.stopPropagation();
    if (editing) stopEditing(true);
    select(event.target);
  }, true);
  // While picking, links, buttons and forms don't act.
  ["submit", "mousedown", "pointerdown", "touchstart"].forEach(function (name) {
    document.addEventListener(name, function (event) { if (picking && name === "submit") event.preventDefault(); }, true);
  });
  document.addEventListener("keydown", function (event) {
    if (editing) {
      if (event.key === "Escape") { event.preventDefault(); stopEditing(false); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); stopEditing(true); }
      return;
    }
    if (picking && event.key === "Escape") { picking = false; place(hoverBox, null); post("picking", { on: false }); }
  }, true);
  window.addEventListener("scroll", function () { place(selectBox, selected); }, true);
  // A new preview size moves everything: hide the hover box and put the selection box back on its element.
  window.addEventListener("resize", function () { place(hoverBox, null); place(selectBox, selected); setTimeout(function () { place(selectBox, selected); }, 50); });

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var cmd = event.data;
    if (!cmd || cmd.source !== TO || cmd.version !== 1) return;
    attach();
    if (cmd.type === "pick") { if (!cmd.on) stopEditing(true); picking = !!cmd.on; if (!picking) place(hoverBox, null); post("picking", { on: picking }); }
    else if (cmd.type === "select") {
      var current = elements[cmd.id];
      if (cmd.id === "first") select(firstChild(document.querySelector("main") || document.body));
      else if (current && cmd.to === "parent") select(current.parentElement);
      else if (current && cmd.to === "child") select(firstChild(current));
      else if (current && cmd.to === "previous") select(visibleSibling(current, -1));
      else if (current && cmd.to === "next") select(visibleSibling(current, 1));
      else if (current) select(current);
    }
    else if (cmd.type === "edit") startEditing(elements[cmd.id]);
    else if (cmd.type === "scan") post("scanned", scan());
    else if (cmd.type === "layers") post("layers", { items: layers() });
    else if (cmd.type === "replay") {
      // The whole list again, after one was removed or changed: back to the original, then each in order.
      reset();
      var list = Array.isArray(cmd.changes) ? cmd.changes.slice(0, 100) : [];
      var failed = [];
      for (var i = 0; i < list.length; i++) if (!apply(list[i])) failed.push(i);
      if (selected) { place(selectBox, selected); post("selected", { element: describe(selected) }); }
      post("replayed", { failed: failed });
    }
  });
  attach();
  post("ready", { title: clean(document.title, 120), tokens: tokens() });
})();
`;
