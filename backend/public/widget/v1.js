/*! Parley chat widget v1.0.0 — embed:
 *  <script>window.ParleyConfig = { botId: "bot_xxx" };</script>
 *  <script async src="https://YOUR-BACKEND/widget/v1.js"></script>
 * Styles are isolated in a Shadow DOM; the only global is window.Parley.
 */
(function () {
  "use strict";
  if (window.Parley && window.Parley.__loaded) return;
  var VERSION = "1.0.0";
  var script = document.currentScript || (function () {
    var s = document.querySelectorAll('script[src*="/widget/v1.js"]');
    return s[s.length - 1];
  })();
  var userCfg = window.ParleyConfig || {};
  var BOT = userCfg.botId || (script && script.getAttribute("data-bot-id"));
  if (!BOT) { console.warn("[Parley] Missing botId (window.ParleyConfig = { botId: '...' })"); return; }
  var API = (userCfg.apiUrl || (script ? new URL(script.src, location.href).origin : "")).replace(/\/$/, "");
  var BASE = API + "/api/widget/" + encodeURIComponent(BOT);
  var KEY = "parley:" + BOT + ":";

  var store = {
    get: function (k) { try { return localStorage.getItem(KEY + k); } catch (e) { return null; } },
    set: function (k, v) { try { v === null ? localStorage.removeItem(KEY + k) : localStorage.setItem(KEY + k, v); } catch (e) {} },
  };
  // Per-tab memory (sessionStorage): survives reloads, forgotten when the tab is closed.
  // Holds the visitor's account ID and whether we already asked for it in this tab.
  var sess = {
    get: function (k) { try { return sessionStorage.getItem(KEY + k); } catch (e) { return S && S["_s" + k] || null; } },
    set: function (k, v) {
      try { v === null ? sessionStorage.removeItem(KEY + k) : sessionStorage.setItem(KEY + k, v); } catch (e) { if (S) S["_s" + k] = v; }
    },
  };

  var S = {
    cfg: null, behavior: {}, availability: {}, open: store.get("open") === "1", visitorId: store.get("vid"), visitorToken: store.get("vtok"),
    conv: store.get("conv"), mode: "ai", messages: [], typing: false, agentTyping: null, emoji: false, contact: false, contactDone: false,
    consent: store.get("consent"), sending: false, es: null, pollTimer: null, lastId: 0, error: null, newBelow: false, ready: false,
    awaitingAcct: false,
  };
  S.awaitingAcct = sess.get("acctWait") === "1";

  // ------------------------------------------------------------------ http
  function req(method, path, body) {
    var h = { "content-type": "application/json" };
    if (S.visitorId) { h["x-visitor-id"] = S.visitorId; h["x-visitor-token"] = S.visitorToken || ""; }
    return fetch(BASE + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, mode: "cors", credentials: "omit" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error((d.error && d.error.message) || "Request failed"); e.status = r.status; e.code = d.error && d.error.code; throw e; }
        return d;
      });
    });
  }
  function upload(path, fd) {
    var h = {};
    if (S.visitorId) { h["x-visitor-id"] = S.visitorId; h["x-visitor-token"] = S.visitorToken || ""; }
    return fetch(BASE + path, { method: "POST", headers: h, body: fd, mode: "cors", credentials: "omit" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error((d.error && d.error.message) || "Upload failed"); e.status = r.status; e.code = d.error && d.error.code; throw e; }
        return d;
      });
    });
  }
  function uid() { return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function lang() { return (navigator.language || "").slice(0, 35); }

  // ------------------------------------------------------------------ DOM / styles
  var host = document.createElement("div");
  host.id = "parley-widget-root";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483000;bottom:0;right:0;width:0;height:0;";
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var styleEl = document.createElement("style");
  var wrap = document.createElement("div");
  root.appendChild(styleEl);
  root.appendChild(wrap);

  var ICONS = {
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    sparkle: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    wave: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4L3.3 16.8a2 2 0 0 1 2.8-2.9L8 15"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    minus: '<path d="M5 12h14"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    retry: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  };
  function icon(n, size) { return '<svg xmlns="http://www.w3.org/2000/svg" width="' + (size || 18) + '" height="' + (size || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || ICONS.chat) + "</svg>"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  // Links in messages (incl. the welcome message) become clickable and open in a new tab:
  // https://…, www.… and plain domains such as example.com/help.
  var URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]]|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|id|app|dev|me|info|biz|xyz|ai|kh|us|uk|in|ph|my|sg|vn|th|shop|store|site|online|link)(?![a-z0-9-])(?:\/[^\s<>"']*[^\s<>"'.,;:!?)\]])?/gi;
  function linkify(s) {
    s = String(s == null ? "" : s);
    var out = "", last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(s))) {
      if (m.index > 0 && /[@\w.\/-]/.test(s.charAt(m.index - 1))) continue; // part of an email or a longer word
      var u = m[0], href = /^https?:\/\//i.test(u) ? u : "https://" + u;
      out += esc(s.slice(last, m.index)) + '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + "</a>";
      last = m.index + u.length;
    }
    return (out + esc(s.slice(last))).replace(/\n/g, "<br>");
  }
  function hm(iso) { var d = iso ? new Date(iso) : new Date(); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  var IMAGE_PLACEHOLDER = "📷 Image"; // text stored with an image that has no caption
  var EMOJIS = ["😀", "😂", "😍", "🥰", "😎", "🤔", "👍", "🙏", "👏", "🎉", "❤️", "🔥", "✨", "☕", "📦", "😅", "😢", "🙌", "👋", "✅"];

  function css(c) {
    var dark = c.theme === "dark" || (c.theme === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
    var bg = dark ? "#16150f" : c.backgroundColor, fg = dark ? "#f4f1ea" : c.textColor, bot = dark ? "#26241e" : c.botBubbleColor;
    var muted = dark ? "#a29d92" : "#7a756d", border = dark ? "#2e2c26" : "rgba(0,0,0,0.08)";
    var grad = "linear-gradient(135deg," + c.primaryColor + "," + c.secondaryColor + ")";
    var isG = c.template === "gradient", isP = c.template === "professional", isM = c.template === "minimal";
    var headerBg = isG ? grad : isP ? (dark ? "#0b0a08" : c.headerColor) : (dark ? bg : c.headerColor);
    var headerFg = isG || isP ? "#fff" : fg;
    var r = Math.max(8, c.radius - 4);
    var side = c.position === "left" ? "left" : "right";
    var shadow = { none: "none", soft: "0 12px 40px -12px rgba(0,0,0,.25)", medium: "0 20px 50px -16px rgba(0,0,0,.35)", strong: "0 30px 70px -20px rgba(0,0,0,.45),0 10px 24px -12px rgba(0,0,0,.25)" }[c.shadow] || "none";
    var font = /system-ui/.test(c.fontFamily) ? "system-ui,-apple-system,Segoe UI,Roboto,sans-serif" : "'" + c.fontFamily.replace(/'/g, "") + "',system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    return [
      ":host{all:initial}",
      "*{box-sizing:border-box;margin:0;padding:0;font-family:" + font + "}",
      ".launcher{position:fixed;bottom:20px;" + side + ":20px;width:" + c.launcherSize + "px;height:" + c.launcherSize + "px;border-radius:999px;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;background:" + (isG ? grad : c.primaryColor) + ";box-shadow:0 12px 28px -8px rgba(0,0,0,.4);transition:transform .2s ease}",
      ".launcher:hover{transform:scale(1.06)}.launcher:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid " + c.primaryColor + ";outline-offset:2px}",
      ".launcher.pulse{animation:pl-pulse 2.4s ease-out infinite}.launcher.bounce{animation:pl-bounce 2.2s ease-in-out infinite}.launcher.wiggle{animation:pl-wiggle 3s ease-in-out infinite}",
      ".badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;border:2px solid #fff}",
      ".panel{position:fixed;bottom:" + (c.launcherSize + 32) + "px;" + side + ":20px;width:" + c.width + "px;height:" + c.height + "px;max-height:calc(100vh - " + (c.launcherSize + 52) + "px);max-width:calc(100vw - 32px);display:flex;flex-direction:column;overflow:hidden;background:" + bg + ";color:" + fg + ";font-size:" + c.fontSize + "px;border-radius:" + c.radius + "px;border:1px solid " + border + ";box-shadow:" + shadow + "}.panel.enter{animation:pl-rise .28s cubic-bezier(.2,.8,.2,1)}",
      "@media (max-width:480px){.panel{inset:0;width:100%;height:100%;max-height:none;max-width:none;border-radius:0;bottom:0}.launcher.hidden-mobile{display:none}}",
      ".hdr{flex-shrink:0;padding:" + (isP ? "16px" : "14px") + " 16px;background:" + headerBg + ";color:" + headerFg + ";" + (isM ? "border-bottom:1px solid " + border + ";" : "") + "}",
      ".hrow{display:flex;align-items:center;gap:12px}.av{flex-shrink:0;width:" + (isP ? 44 : 36) + "px;height:" + (isP ? 44 : 36) + "px;display:flex;align-items:center;justify-content:center;font-weight:600;border-radius:" + (isM ? "10px" : "999px") + ";background:" + (isM ? c.primaryColor : "rgba(255,255,255,.18)") + ";color:#fff;overflow:hidden}.av img{width:100%;height:100%;object-fit:cover}",
      ".ttl{font-weight:600;font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{display:flex;align-items:center;gap:6px;font-size:.8em;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dot{width:8px;height:8px;border-radius:99px;display:inline-block}",
      ".hbtn{margin-left:auto;width:32px;height:32px;border:0;border-radius:99px;background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.8}.hbtn:hover{opacity:1;background:rgba(127,127,127,.15)}",
      ".psub{margin-top:12px;border-radius:8px;padding:8px 12px;font-size:.8em;background:rgba(255,255,255,.1)}",
      ".ann{flex-shrink:0;padding:8px 16px;text-align:center;font-weight:500;font-size:.8em;background:" + c.primaryColor + "14;color:" + (dark ? fg : c.primaryColor) + "}",
      ".msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}.msgs::-webkit-scrollbar{width:6px}.msgs::-webkit-scrollbar-thumb{background:" + border + ";border-radius:9px}",
      ".it.enter{animation:pl-in .25s ease}.ctas{display:flex;flex-direction:column;gap:8px}.row{display:flex}.row.v{justify-content:flex-end}.mwrap{max-width:82%}.who{font-size:.72em;font-weight:500;color:" + muted + ";margin-bottom:4px}",
      ".bub{padding:10px 14px;line-height:1.5;white-space:normal;word-wrap:break-word;overflow-wrap:anywhere}.bub a{color:inherit;text-decoration:underline}",
      ".att{display:block;width:220px;max-width:100%;border-radius:" + r + "px;overflow:hidden;border:1px solid " + border + ";background:" + bot + ";margin-bottom:4px}.row.v .att{margin-left:auto}.att img{display:block;width:100%;height:auto;max-height:260px;object-fit:cover}.row.v .att + .bub{margin-top:0}",
      ".row.v .bub{background:" + (isG ? "linear-gradient(135deg," + c.bubbleColor + "," + c.secondaryColor + ")" : c.bubbleColor) + ";color:#fff;border-radius:" + r + "px " + r + "px 4px " + r + "px}",
      ".row.b .bub{background:" + bot + ";color:" + fg + ";border:" + (isM || isP ? "1px solid " + border : "0") + ";border-radius:" + r + "px " + r + "px " + r + "px 4px}",
      ".row.h .bub{background:" + (dark ? "#2d2a22" : "#1f1d1a") + ";color:#fff;border-radius:" + r + "px " + r + "px " + r + "px 4px}",
      ".meta{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:.7em;color:" + muted + "}.row.v .meta{justify-content:flex-end}.meta button{border:0;background:none;color:inherit;cursor:pointer;opacity:0;transition:opacity .15s;display:inline-flex}.row:hover .meta button,.meta button:focus{opacity:1}.meta .err{color:#ef4444;opacity:1;gap:4px;align-items:center}",
      ".sys{display:flex;align-items:center;gap:10px;font-size:.72em;color:" + muted + "}.sys:before,.sys:after{content:'';flex:1;height:1px;background:" + border + "}",
      ".chips{display:flex;flex-wrap:wrap;gap:8px}.chip{cursor:pointer;border-radius:99px;padding:6px 12px;font-weight:500;font-size:.82em;background:transparent;border:1px solid " + c.primaryColor + "55;color:" + (dark ? fg : c.primaryColor) + ";transition:transform .15s}.chip:hover{transform:translateY(-1px)}",
      ".cta{display:flex;align-items:center;justify-content:space-between;gap:8px;border-radius:12px;padding:10px 14px;font-weight:500;font-size:.85em;background:" + bot + ";border:1px solid " + border + ";color:" + fg + ";text-decoration:none}.cta:hover{border-color:" + c.primaryColor + "}",
      ".typing{display:flex;gap:4px;width:fit-content;padding:12px 14px;border-radius:16px;background:" + bot + "}.typing span{width:6px;height:6px;border-radius:9px;background:" + muted + ";animation:pl-typing 1.2s infinite}.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}",
      ".newmsg{position:absolute;left:50%;transform:translateX(-50%);bottom:84px;border:0;border-radius:99px;padding:4px 12px;font-size:.75em;font-weight:600;color:#fff;background:" + c.primaryColor + ";cursor:pointer;box-shadow:0 6px 16px rgba(0,0,0,.2)}",
      ".comp{position:relative;flex-shrink:0;padding:8px 12px 12px;border-top:1px solid " + border + "}",
      ".form{display:flex;align-items:center;gap:6px;border-radius:99px;padding:4px 4px 4px 8px;background:" + (dark ? "#211f19" : "rgba(0,0,0,.04)") + ";border:1px solid " + border + "}",
      ".ibtn{width:32px;height:32px;border:0;background:none;color:" + muted + ";cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:99px;flex-shrink:0}",
      ".form:focus-within{border-color:" + c.primaryColor + "88}.inp:focus,.inp:focus-visible{outline:none}",
      ".inp{flex:1;min-width:0;border:0;outline:0;background:transparent;color:" + fg + ";font-size:.95em;padding:6px 0}.inp::placeholder{color:" + muted + "}",
      ".send{width:36px;height:36px;border:0;border-radius:99px;display:flex;align-items:center;justify-content:center;color:#fff;background:" + c.sendColor + ";cursor:pointer;flex-shrink:0;transition:transform .15s}.send:hover{transform:scale(1.05)}.send:disabled{opacity:.4;cursor:default;transform:none}",
      ".emo{position:absolute;bottom:100%;left:12px;margin-bottom:8px;display:grid;grid-template-columns:repeat(5,1fr);gap:4px;padding:8px;border-radius:16px;background:" + bg + ";border:1px solid " + border + ";box-shadow:0 12px 30px rgba(0,0,0,.18)}.emo button{width:32px;height:32px;border:0;background:none;font-size:18px;cursor:pointer;border-radius:8px}.emo button:hover{background:" + border + "}",
      ".brand{margin-top:8px;display:flex;align-items:center;justify-content:center;gap:4px;font-size:.72em;color:" + muted + "}.brand b{font-weight:700}",
      ".talk{display:inline-flex;align-items:center;gap:5px;border:0;background:none;padding:2px 6px;border-radius:99px;font-size:1em;font-weight:600;cursor:pointer;color:" + (dark ? fg : c.primaryColor) + "}.talk:hover{text-decoration:underline}.talk:disabled{opacity:.6;cursor:default;text-decoration:none}",
      ".card{border-radius:14px;padding:14px;background:" + bot + ";border:1px solid " + border + ";display:flex;flex-direction:column;gap:8px}.card p{font-size:.85em;line-height:1.45}",
      ".field{width:100%;border-radius:10px;border:1px solid " + border + ";padding:9px 12px;font-size:.9em;background:" + bg + ";color:" + fg + "}",
      ".pbtn{border:0;border-radius:99px;padding:9px 14px;font-weight:600;font-size:.85em;cursor:pointer;color:#fff;background:" + (isG ? grad : c.primaryColor) + "}.gbtn{border:1px solid " + border + ";border-radius:99px;padding:9px 14px;font-weight:600;font-size:.85em;cursor:pointer;color:" + fg + ";background:transparent}",
      ".notice{display:flex;gap:8px;align-items:center;border-radius:12px;padding:8px 12px;font-size:.8em;background:" + bot + ";color:" + muted + "}",
      "@keyframes pl-rise{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}@keyframes pl-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
      "@keyframes pl-typing{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}",
      "@keyframes pl-pulse{0%{box-shadow:0 0 0 0 " + c.primaryColor + "66,0 12px 28px -8px rgba(0,0,0,.4)}70%{box-shadow:0 0 0 14px " + c.primaryColor + "00,0 12px 28px -8px rgba(0,0,0,.4)}100%{box-shadow:0 0 0 0 " + c.primaryColor + "00,0 12px 28px -8px rgba(0,0,0,.4)}}",
      "@keyframes pl-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}@keyframes pl-wiggle{0%,90%,100%{transform:rotate(0)}93%{transform:rotate(-10deg)}96%{transform:rotate(10deg)}}",
      "@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}",
    ].join("\n");
  }

  // ------------------------------------------------------------------ rendering
  // The panel is built once per open and then patched in place: only parts whose HTML changed are
  // touched, messages are keyed, and entrance animations run only for newly added elements. This
  // keeps the chat steady (no flicker / re-animation / avatar reload) when messages come and go.
  var unread = 0;
  var dom = { panel: null, hdr: null, ann: null, msgs: null, comp: null, emo: null, form: null, foot: null, newBtn: null, launcher: null, items: {}, formKey: null };
  function welcomeList() {
    var c = S.cfg, out = [];
    if (c.welcomeEnabled && c.welcomeMessage) out.push({ id: "welcome", sender_type: "ai", content: c.welcomeMessage, sent_at: null, welcome: true });
    return out;
  }
  function setHtml(node, html) {
    if (node && node._html !== html) { node.innerHTML = html; node._html = html; }
  }
  function blockedNow() { return Boolean(S.behavior.consent_required && S.consent !== "granted"); }

  function headerHtml() {
    var c = S.cfg, online = c.online, isP = c.template === "professional";
    var h = '<div class="hrow"><div class="av">' + (c.avatarUrl ? '<img src="' + esc(c.avatarUrl) + '" alt="">' : esc(c.avatar || (c.assistantName || "?")[0])) + "</div>";
    h += '<div style="min-width:0;flex:1"><div class="ttl">' + esc(c.title) + '</div><div class="sub"><span class="dot" style="background:' + (online ? "#22c55e" : "#a1a1aa") + '"></span>' + esc(S.mode === "human" ? (S.agentName ? S.agentName + " is here to help" : "A person will reply here shortly") : online ? c.availabilityText : c.offlineText) + "</div></div>";
    h += '<button class="hbtn" data-a="close" aria-label="Minimize chat">' + icon(window.innerWidth <= 480 ? "x" : "minus", 16) + "</button></div>";
    if (isP && c.subtitle) h += '<div class="psub">' + esc(c.subtitle) + "</div>";
    return h;
  }

  function messageHtml(m) {
    var c = S.cfg;
    if (m.content_type === "system_event" || m.sender_type === "system") return '<div class="sys">' + esc(m.content) + "</div>";
    var v = m.sender_type === "visitor", h = m.sender_type === "human";
    var html = '<div class="row ' + (v ? "v" : h ? "h" : "b") + '"><div class="mwrap">';
    if (!v) html += '<div class="who">' + esc(h ? (m.sender_name || "Support") : c.assistantName) + (m.answer_source === "faq" ? " · FAQ" : "") + "</div>";
    var att = m.attachment && m.attachment.type === "image" ? m.attachment : null;
    var src = m._localUrl || (att && att.url);
    if (src) html += '<a class="att" href="' + esc((att && att.url) || src) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(src) + '" alt="' + esc((att && att.name) || "Image") + '"></a>';
    if (!src || (m.content && m.content !== IMAGE_PLACEHOLDER)) html += '<div class="bub">' + linkify(m.content) + "</div>";
    html += '<div class="meta"><span>' + (m.sent_at || !m.welcome ? hm(m.sent_at) : "") + "</span>";
    if (v && m._status === "sending") html += "<span>Sending…</span>";
    if (v && m._status === "failed") html += '<button class="err" data-a="retry" data-id="' + esc(m.client_message_id) + '">' + icon("retry", 12) + " Not sent · Retry</button>";
    html += '<button data-a="copy" data-id="' + esc(m.id) + '" aria-label="Copy message">' + icon(m._copied ? "check" : "copy", 12) + "</button></div></div></div>";
    return html;
  }

  function listItems() {
    var c = S.cfg, items = [];
    if (!c.online) items.push({ k: "offline", html: '<div class="notice">' + esc(c.offlineText) + "</div>" });
    if (blockedNow()) {
      items.push({ k: "consent", html: '<div class="card"><p>' + esc(S.behavior.consent_text || "We store this chat to answer your questions.") + (S.behavior.privacy_policy_url ? ' <a href="' + esc(S.behavior.privacy_policy_url) + '" target="_blank" rel="noopener">Privacy policy</a>' : "") + '</p><div style="display:flex;gap:8px"><button class="pbtn" data-a="consent-yes">Accept & chat</button><button class="gbtn" data-a="consent-no">No thanks</button></div></div>' });
      return items;
    }
    welcomeList().concat(S.messages).forEach(function (m) {
      items.push({ k: "m:" + (m.client_message_id || m.id), html: messageHtml(m) });
    });
    if (S.messages.length === 0) {
      if (c.suggestions && c.suggestions.length) {
        var ch = '<div class="chips">';
        c.suggestions.forEach(function (s, i) { ch += '<button class="chip" data-a="suggest" data-i="' + i + '">' + esc(s) + "</button>"; });
        items.push({ k: "chips", html: ch + "</div>" });
      }
      if (c.ctas && c.ctas.length) {
        var ct = "";
        c.ctas.forEach(function (b) { ct += '<a class="cta" href="' + esc(b.url) + '" target="_blank" rel="noopener noreferrer">' + esc(b.label) + icon("link", 14) + "</a>"; });
        items.push({ k: "ctas", html: '<div class="ctas">' + ct + "</div>" });
      }
    }
    if (S.contact && !S.contactDone) {
      items.push({ k: "contact", html: '<form class="card" data-f="contact"><p>Leave your details and the team will get back to you.</p><input class="field" name="name" placeholder="Your name" autocomplete="name"><input class="field" name="email" type="email" placeholder="Email address" autocomplete="email"><input class="field" name="phone" placeholder="Phone (optional)" autocomplete="tel"><div style="display:flex;gap:8px"><button class="pbtn" type="submit">Send details</button><button class="gbtn" type="button" data-a="contact-skip">Not now</button></div></form>' });
    }
    if (S.typing || S.agentTyping) items.push({ k: "typing", html: '<div class="typing" aria-label="Typing"><span></span><span></span><span></span></div>' });
    if (S.error) items.push({ k: "error", html: '<div class="notice" style="color:#ef4444">' + esc(S.error) + "</div>" });
    return items;
  }

  function nearBottom(el, px) { return el.scrollHeight - el.scrollTop - el.clientHeight < (px || 120); }
  function scrollToBottom() {
    var el = dom.msgs;
    if (!el) return;
    el.style.scrollBehavior = "auto"; el.scrollTop = el.scrollHeight; el.style.scrollBehavior = "";
  }

  function renderList(firstPaint) {
    var box = dom.msgs, prev = dom.items, next = {}, changed = false;
    var stick = firstPaint || nearBottom(box);
    var cursor = box.firstChild;
    listItems().forEach(function (it) {
      var node = prev[it.k];
      if (node) {
        if (node._html !== it.html) { node.innerHTML = it.html; node._html = it.html; changed = true; }
      } else {
        node = document.createElement("div");
        node.className = firstPaint ? "it" : "it enter";
        node.innerHTML = it.html; node._html = it.html;
        node.addEventListener("animationend", function () { node.classList.remove("enter"); });
        changed = true;
      }
      next[it.k] = node;
      if (node !== cursor) box.insertBefore(node, cursor);
      else cursor = cursor.nextSibling;
    });
    Object.keys(prev).forEach(function (k) { if (!next[k]) { prev[k].remove(); changed = true; } });
    dom.items = next;
    if (changed && stick) scrollToBottom();
  }

  function renderComposer() {
    var c = S.cfg, blocked = blockedNow();
    var key = [blocked, c.enable_emoji_picker !== false, S.behavior.max_message_length || 500].join("|");
    if (dom.formKey !== key) {
      // rebuilt only when these settings change; keeps the typed text and focus
      var old = dom.form && dom.form.querySelector(".inp");
      var val = old ? old.value : S.draft || "";
      var hadFocus = old && root.activeElement === old;
      var f = "";
      if (c.enable_emoji_picker !== false) f += '<button type="button" class="ibtn" data-a="emoji-toggle" aria-label="Add emoji"' + (blocked ? " disabled" : "") + ">" + icon("smile", 18) + "</button>";
      f += '<button type="button" class="ibtn" data-a="attach" aria-label="Attach an image"' + (blocked ? " disabled" : "") + ">" + icon("clip", 17) + "</button>";
      f += '<input class="inp" name="m" maxlength="' + (S.behavior.max_message_length || 500) + '" placeholder="Type a message…" aria-label="Message" autocomplete="off"' + (blocked ? " disabled" : "") + ">";
      f += '<button class="send" type="submit" aria-label="Send message" disabled>' + icon("send", 16) + "</button>";
      dom.form.innerHTML = f;
      dom.formKey = key;
      var inp = dom.form.querySelector(".inp");
      inp.value = val;
      if (hadFocus) inp.focus();
    }
    var i2 = dom.form.querySelector(".inp"), sb = dom.form.querySelector(".send");
    if (sb) sb.disabled = !(i2 && i2.value.trim()) || S.sending;
    var showEmo = S.emoji && !blocked;
    if (showEmo && !dom.emo._html) {
      var e = "";
      EMOJIS.forEach(function (x) { e += '<button type="button" data-a="emoji" data-e="' + x + '">' + x + "</button>"; });
      setHtml(dom.emo, e);
    }
    dom.emo.style.display = showEmo ? "" : "none";
    var foot = "";
    if (c.showBranding !== false) {
      if (S.mode === "human") foot = '<div class="brand">' + icon("wave", 12) + " You're chatting with our team</div>";
      else foot = '<div class="brand"><button type="button" class="talk" data-a="talk"' + (S.talking || blocked ? " disabled" : "") + ">" + icon("wave", 13) + (S.talking ? " Connecting…" : " Talk to a person") + "</button></div>";
    }
    setHtml(dom.foot, foot);
  }

  function launcherHtml() {
    var c = S.cfg;
    return icon(S.open ? "x" : c.launcherIcon, S.open ? 20 : 24) + (!S.open && unread ? '<span class="badge">' + unread + "</span>" : "");
  }

  function buildPanel() {
    var p = document.createElement("div");
    p.className = "panel enter";
    p.setAttribute("role", "dialog");
    p.addEventListener("animationend", function (e) { if (e.target === p) p.classList.remove("enter"); });
    dom.hdr = document.createElement("div"); dom.hdr.className = "hdr";
    dom.ann = document.createElement("div"); dom.ann.className = "ann";
    dom.msgs = document.createElement("div"); dom.msgs.className = "msgs"; dom.msgs.setAttribute("aria-live", "polite");
    dom.comp = document.createElement("div"); dom.comp.className = "comp";
    dom.emo = document.createElement("div"); dom.emo.className = "emo"; dom.emo.style.display = "none";
    dom.form = document.createElement("form"); dom.form.className = "form"; dom.form.setAttribute("data-f", "send");
    dom.foot = document.createElement("div");
    dom.file = document.createElement("input");
    dom.file.type = "file"; dom.file.accept = "image/png,image/jpeg,image/webp,image/gif"; dom.file.style.display = "none";
    dom.file.addEventListener("change", function () { var f = dom.file.files && dom.file.files[0]; dom.file.value = ""; if (f) sendImage(f); });
    dom.comp.appendChild(dom.emo); dom.comp.appendChild(dom.form); dom.comp.appendChild(dom.file); dom.comp.appendChild(dom.foot);
    p.appendChild(dom.hdr); p.appendChild(dom.ann); p.appendChild(dom.msgs); p.appendChild(dom.comp);
    dom.msgs.addEventListener("scroll", function () {
      if (S.newBelow && nearBottom(dom.msgs, 40)) { S.newBelow = false; if (dom.newBtn) { dom.newBtn.remove(); dom.newBtn = null; } }
    });
    dom.items = {}; dom.formKey = null;
    dom.panel = p;
    wrap.insertBefore(p, dom.launcher || null);
  }

  function render() {
    if (!S.cfg) return;
    var c = S.cfg;
    if (S.open) {
      var first = !dom.panel;
      if (first) buildPanel();
      if (dom.panel.getAttribute("aria-label") !== c.title) dom.panel.setAttribute("aria-label", c.title);
      setHtml(dom.hdr, headerHtml());
      var annOn = Boolean(c.announcementEnabled && c.announcementText);
      dom.ann.style.display = annOn ? "" : "none";
      if (annOn) setHtml(dom.ann, esc(c.announcementText));
      renderList(first);
      if (S.newBelow && !dom.newBtn) {
        dom.newBtn = document.createElement("button");
        dom.newBtn.className = "newmsg"; dom.newBtn.setAttribute("data-a", "scroll"); dom.newBtn.textContent = "↓ New message";
        dom.panel.insertBefore(dom.newBtn, dom.comp);
      } else if (!S.newBelow && dom.newBtn) { dom.newBtn.remove(); dom.newBtn = null; }
      renderComposer();
    } else if (dom.panel) {
      dom.panel.remove();
      dom.panel = dom.hdr = dom.ann = dom.msgs = dom.comp = dom.emo = dom.form = dom.foot = dom.newBtn = dom.file = null;
      dom.items = {}; dom.formKey = null;
    }
    if (!dom.launcher) {
      dom.launcher = document.createElement("button");
      dom.launcher.setAttribute("data-a", "toggle");
      wrap.appendChild(dom.launcher);
    }
    var anim = !S.open && c.launcherAnimation && c.launcherAnimation !== "none" ? " " + c.launcherAnimation : "";
    var cls = "launcher" + anim + (S.open ? " hidden-mobile" : "");
    if (dom.launcher.className !== cls) dom.launcher.className = cls;
    dom.launcher.setAttribute("aria-label", S.open ? "Close chat" : "Open chat");
    dom.launcher.setAttribute("aria-expanded", String(S.open));
    setHtml(dom.launcher, launcherHtml());
  }

  // ------------------------------------------------------------------ events
  wrap.addEventListener("click", function (e) {
    var t = e.target.closest("[data-a]");
    if (!t) return;
    var a = t.getAttribute("data-a");
    if (a === "toggle") setOpen(!S.open);
    else if (a === "close") setOpen(false);
    else if (a === "suggest") send(S.cfg.suggestions[Number(t.getAttribute("data-i"))]);
    else if (a === "emoji-toggle") { S.emoji = !S.emoji; render(); }
    else if (a === "emoji") { var i = wrap.querySelector(".inp"); i.value += t.getAttribute("data-e"); i.focus(); wrap.querySelector(".send").disabled = false; }
    else if (a === "copy") {
      var m = S.messages.concat(welcomeList()).find(function (x) { return String(x.id) === t.getAttribute("data-id"); });
      if (m && navigator.clipboard) navigator.clipboard.writeText(m.content).then(function () { m._copied = true; render(); setTimeout(function () { m._copied = false; render(); }, 1200); });
    } else if (a === "retry") {
      var f = S.messages.find(function (x) { return x.client_message_id === t.getAttribute("data-id"); });
      if (f) deliver(f);
    } else if (a === "scroll") { var el = wrap.querySelector(".msgs"); el.scrollTop = el.scrollHeight; S.newBelow = false; render(); }
    else if (a === "consent-yes") consent("granted");
    else if (a === "consent-no") { consent("denied"); setOpen(false); }
    else if (a === "contact-skip") { S.contact = false; render(); }
    else if (a === "talk") talkToPerson();
    else if (a === "attach") { if (dom.file && !blockedNow()) dom.file.click(); }
  });
  // pasting a screenshot into the message box attaches it
  wrap.addEventListener("paste", function (e) {
    if (!e.target.classList || !e.target.classList.contains("inp")) return;
    var items = (e.clipboardData && e.clipboardData.files) || [];
    for (var i = 0; i < items.length; i++) if (/^image\//.test(items[i].type)) { e.preventDefault(); sendImage(items[i]); return; }
  });
  var typingTimer = null;
  wrap.addEventListener("input", function (e) {
    if (!e.target.classList.contains("inp")) return;
    S.draft = e.target.value;
    var b = wrap.querySelector(".send");
    if (b) b.disabled = !e.target.value.trim() || S.sending;
    if (S.conv && S.mode === "human" && !typingTimer) {
      req("POST", "/typing", { conversation_uid: S.conv, typing: true }).catch(function () {});
      typingTimer = setTimeout(function () { typingTimer = null; }, 3000);
    }
  });
  wrap.addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target.getAttribute("data-f");
    if (f === "send") { var i = wrap.querySelector(".inp"); var v = i.value; i.value = ""; S.draft = ""; S.emoji = false; send(v); }
    if (f === "contact") {
      var fd = new FormData(e.target);
      var body = { name: fd.get("name") || null, email: fd.get("email") || null, phone: fd.get("phone") || null, conversation_uid: S.conv };
      if (!body.email && !body.phone) { S.error = "Please leave an email or phone number."; render(); return; }
      req("POST", "/contact", body).then(function () { S.contactDone = true; S.contact = false; S.error = null; S.messages.push({ id: uid(), sender_type: "system", content_type: "system_event", content: "Thanks! We'll be in touch." }); render(); })
        .catch(function (err) { S.error = err.message; render(); });
    }
  });
  wrap.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.open) setOpen(false); });

  function setOpen(v) {
    S.open = v;
    store.set("open", v ? "1" : "0");
    if (v) { unread = 0; ensureSession(); }
    render();
    if (v) setTimeout(function () { var i = wrap.querySelector(".inp"); if (i && window.innerWidth > 480) i.focus(); }, 50);
  }

  // ------------------------------------------------------------------ session / messages
  var sessionPromise = null;
  function ensureSession() {
    if (S.behavior.consent_required && S.consent !== "granted") return Promise.resolve();
    if (sessionPromise) return sessionPromise;
    sessionPromise = req("POST", "/session", { visitor_id: S.visitorId, visitor_token: S.visitorToken, page_url: location.href, referrer: document.referrer || null, lang: lang(), consent: S.consent === "granted" ? "granted" : null })
      .then(function (d) {
        S.visitorId = d.visitor_id; S.visitorToken = d.visitor_token;
        store.set("vid", d.visitor_id); store.set("vtok", d.visitor_token);
        if (d.conversation && d.conversation.status !== "closed") { S.conv = d.conversation.conversation_uid; S.mode = d.conversation.handling_mode; store.set("conv", S.conv); }
        else { S.conv = null; store.set("conv", null); }
        S.messages = d.messages || [];
        S.lastId = S.messages.reduce(function (a, m) { return Math.max(a, Number(m.id) || 0); }, 0);
        connectEvents();
        render();
      })
      .catch(function (e) { sessionPromise = null; S.error = e.status === 403 ? null : "Couldn't connect. Check your connection and try again."; render(); });
    return sessionPromise;
  }
  function consent(status) {
    S.consent = status; store.set("consent", status);
    render();
    if (status === "granted") ensureSession().then(function () { return req("POST", "/consent", { status: status }); }).catch(function () {});
  }
  function addMessage(m) {
    if (!m) return;
    var i = S.messages.findIndex(function (x) { return (x.id && x.id === m.id) || (m.client_message_id && x.client_message_id === m.client_message_id); });
    if (i >= 0) S.messages[i] = Object.assign({}, S.messages[i], m, { _status: null });
    else S.messages.push(m);
    S.lastId = Math.max(S.lastId, Number(m.id) || 0);
    if (!S.open && m.sender_type !== "visitor") unread++;
  }
    // ---- account ID memory (this tab only)
  var NOT_AN_ID = /^(hi|hello|hey|ok|okay|yes|no|thanks|thank|please|help|halo|hai|ya|iya|tidak|bukan|terima|kasih|tolong)$/i;
  /** Pull an account ID out of a reply such as "12345", "ACC-889" or "my id is 12345". */
  function extractAccountId(text) {
    var t = String(text || "").trim();
    if (!t || t.length > 200) return null;
    var tokens = t.split(/[\s,;:]+/).map(function (x) { return x.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""); }).filter(Boolean);
    for (var i = 0; i < tokens.length; i++) if (/\d/.test(tokens[i]) && tokens[i].length >= 3 && tokens[i].length <= 64) return tokens[i];
    if (tokens.length === 1 && tokens[0].length >= 3 && tokens[0].length <= 64 && !NOT_AN_ID.test(tokens[0])) return tokens[0];
    return null;
  }
  function accountId() { return sess.get("acct"); }
  function accountAsked() { return sess.get("acctAsked") === "1" || Boolean(accountId()); }
  /** The bot just asked for (or asked to confirm) the account ID: remember that and read the next replies for it. */
  function markAccountAsked() { sess.set("acctAsked", "1"); S.awaitingAcct = true; sess.set("acctWait", "1"); }
  function captureAccountId(text) {
    if (!S.awaitingAcct) return;
    var id = extractAccountId(text);
    if (!id) return;
    sess.set("acct", id); S.awaitingAcct = false; sess.set("acctWait", null);
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text) return;
    captureAccountId(text);
    var m = { id: uid(), client_message_id: uid(), sender_type: "visitor", content: text, sent_at: new Date().toISOString(), _status: "sending" };
    S.messages.push(m);
    render();
    ensureSession().then(function () { deliver(m); });
  }
  function deliver(m) {
    if (m._file) return deliverImage(m);
    m._status = "sending"; S.error = null;
    if (S.mode !== "human") S.typing = true;
    render();
    req("POST", "/messages", { conversation_uid: S.conv, client_message_id: m.client_message_id, content: m.content, page_url: location.href, lang: lang() })
      .then(function (d) {
        S.typing = false;
        S.conv = d.conversation.conversation_uid; store.set("conv", S.conv); S.mode = d.conversation.handling_mode;
        addMessage(d.message);
        if (d.reply) addMessage(d.reply);
        if (d.collect_contact && !S.contactDone) S.contact = true;
        render();
      })
      .catch(function (e) {
        S.typing = false; m._status = "failed";
        if (e.code === "invalid_visitor") { sessionPromise = null; S.visitorId = null; store.set("vid", null); }
        S.error = e.status === 429 || e.code === "message_too_long" ? e.message : null;
        render();
      });
  }

  /** "Talk to a person": fixed reply, then every message goes to the team (the AI stays quiet). */
  function talkToPerson() {
    if (S.talking || S.mode === "human" || blockedNow()) return;
    S.talking = true; S.error = null;
    render();
    ensureSession()
      .then(function () {
        if (!S.visitorId) throw new Error("no session");
        return req("POST", "/talk-to-person", { conversation_uid: S.conv, page_url: location.href, lang: lang(), account_id: accountId() });
      })
      .then(function (d) {
        S.talking = false; S.typing = false;
        S.conv = d.conversation.conversation_uid; store.set("conv", S.conv); S.mode = d.conversation.handling_mode;
        if (d.reply) addMessage(d.reply);
        if (d.asked_account_id) markAccountAsked();
        render();
      })
      .catch(function () { S.talking = false; S.error = "Couldn't reach the team. Please try again."; render(); });
  }

  // ---- image attachments: sent to the team only, the AI never sees them
  var IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
  var MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  /** Shrink big photos (phones) to max 1600px JPEG before upload; small images and GIFs are sent as they are. */
  function shrinkImage(file) {
    return new Promise(function (resolve) {
      if (file.type === "image/gif" || file.size <= 1.5 * 1024 * 1024 || !window.URL || !document.createElement("canvas").toBlob) return resolve(file);
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
        var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) {
          if (!b || b.size >= file.size) return resolve(file);
          try { resolve(new File([b], String(file.name || "image").replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" })); } catch (e) { b.name = "image.jpg"; resolve(b); }
        }, "image/jpeg", 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function sendImage(file) {
    if (blockedNow()) return;
    if (!IMAGE_TYPES.test(file.type || "")) { S.error = "You can attach PNG, JPG, WEBP or GIF images."; render(); return; }
    shrinkImage(file).then(function (f) {
      if (f.size > MAX_IMAGE_BYTES) { S.error = "That image is too large (max 5 MB)."; render(); return; }
      var m = { id: uid(), client_message_id: uid(), sender_type: "visitor", content: IMAGE_PLACEHOLDER, sent_at: new Date().toISOString(), _status: "sending", _file: f, _localUrl: window.URL ? URL.createObjectURL(f) : null, attachment: { type: "image", name: f.name || "image" } };
      S.messages.push(m);
      render();
      ensureSession().then(function () { deliverImage(m); });
    });
  }
  function deliverImage(m) {
    m._status = "sending"; S.error = null;
    render();
    var fd = new FormData();
    if (S.conv) fd.append("conversation_uid", S.conv);
    fd.append("client_message_id", m.client_message_id);
    fd.append("page_url", location.href.slice(0, 2048));
    fd.append("lang", lang());
    if (accountId()) fd.append("account_id", accountId());
    fd.append("account_asked", accountAsked() ? "1" : "0");
    fd.append("file", m._file, m._file.name || "image.jpg");
    upload("/attachments", fd)
      .then(function (d) {
        S.conv = d.conversation.conversation_uid; store.set("conv", S.conv); S.mode = d.conversation.handling_mode;
        var local = m._localUrl;
        m._file = null;
        addMessage(Object.assign({}, d.message, { _localUrl: local }));
        if (d.reply) addMessage(d.reply);
        if (d.asked_account_id) markAccountAsked();
        render();
      })
      .catch(function (e) {
        m._status = "failed";
        if (e.code === "invalid_visitor") { sessionPromise = null; S.visitorId = null; store.set("vid", null); }
        S.error = e.status === 413 || e.status === 429 || e.code === "invalid_file_type" ? e.message : null;
        render();
      });
  }

  // ------------------------------------------------------------------ realtime (SSE, falls back to polling)
  var sseFails = 0;
  function connectEvents() {
    if (S.es || !S.visitorId || typeof EventSource === "undefined") { if (typeof EventSource === "undefined") startPolling(); return; }
    var es = new EventSource(BASE + "/events?visitor_id=" + encodeURIComponent(S.visitorId) + "&visitor_token=" + encodeURIComponent(S.visitorToken));
    S.es = es;
    es.addEventListener("open", function () { sseFails = 0; stopPolling(); });
    es.addEventListener("message", function (e) {
      var m = JSON.parse(e.data);
      if (S.conv && m.conversation_uid !== S.conv) return;
      var el = wrap.querySelector(".msgs");
      var near = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      S.agentTyping = null;
      addMessage(m);
      if (!near) S.newBelow = true;
      render();
    });
    es.addEventListener("typing", function (e) {
      var d = JSON.parse(e.data);
      if (d.sender_type !== "human") return;
      S.agentTyping = d.typing ? d.name || "Support" : null;
      render();
      clearTimeout(S._tt); if (d.typing) S._tt = setTimeout(function () { S.agentTyping = null; render(); }, 6000);
    });
    es.addEventListener("conversation", function (e) {
      var d = JSON.parse(e.data);
      if (S.conv && d.conversation_uid !== S.conv) return;
      S.mode = d.handling_mode; S.agentName = d.agent_name || null;
      render();
    });
    es.addEventListener("config_updated", function () { loadConfig(); });
    es.onerror = function () {
      sseFails++;
      if (sseFails > 3) { es.close(); S.es = null; startPolling(); setTimeout(connectEvents, 30000); }
    };
  }
  function startPolling() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(function () {
      if (!S.conv || !S.open) return;
      req("GET", "/conversations/" + encodeURIComponent(S.conv) + "/messages?after=" + S.lastId).then(function (d) {
        S.mode = d.handling_mode;
        if (d.messages.length) { d.messages.forEach(addMessage); render(); }
      }).catch(function () {});
    }, 4000);
  }
  function stopPolling() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }

  // ------------------------------------------------------------------ boot
  function loadConfig() {
    return req("GET", "/config?v=" + VERSION + "&page_url=" + encodeURIComponent(location.href.slice(0, 500))).then(function (d) {
      S.cfg = d.config; S.behavior = d.behavior || {}; S.availability = d.availability || {};
      var nextCss = css(S.cfg);
      if (styleEl.textContent !== nextCss) styleEl.textContent = nextCss;
      if (!host.isConnected) document.body.appendChild(host);
      S.ready = true;
      render();
      if (!S.behavior.consent_required || S.consent === "granted") ensureSession();
    }).catch(function (e) {
      if (e.code === "domain_not_allowed") console.warn("[Parley] " + e.message);
      else if (e.code === "not_published") console.info("[Parley] Chatbot is not published yet.");
      else console.warn("[Parley] Could not load chatbot:", e.message);
    });
  }

  window.Parley = {
    __loaded: true,
    version: VERSION,
    open: function () { if (S.ready) setOpen(true); },
    close: function () { if (S.ready) setOpen(false); },
    toggle: function () { if (S.ready) setOpen(!S.open); },
    identify: function (info) { return ensureSession().then(function () { return req("POST", "/identify", { name: info && info.name, email: info && info.email, phone: info && info.phone }); }); },
    refresh: function () { return loadConfig(); },
  };

  function boot() {
    loadConfig().then(function () {
      if (S.cfg && !/system-ui|Georgia|Arial|Helvetica/.test(S.cfg.fontFamily)) {
        var l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(S.cfg.fontFamily) + ":wght@400;500;600;700&display=swap";
        document.head.appendChild(l);
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
