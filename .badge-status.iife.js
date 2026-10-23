"use strict";
var SidebarStatus = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/research/client/sidebar-status.ts
  var sidebar_status_exports = {};
  __export(sidebar_status_exports, {
    mountSidebarStatus: () => mountSidebarStatus,
    sidebarStatusText: () => sidebarStatusText
  });

  // packages/research/client/seen.ts
  var SEEN_EVENT = "dsh-pro:topic-seen";
  function storageKey(panelId) {
    return `dsh-pro:seen:${panelId}`;
  }
  function storage() {
    try {
      return typeof localStorage === "undefined" ? void 0 : localStorage;
    } catch {
      return void 0;
    }
  }
  function read(panelId) {
    const store = storage();
    if (store === void 0) return {};
    try {
      const parsed = JSON.parse(store.getItem(storageKey(panelId)) ?? "{}");
      return parsed !== null && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function isTopicSeen(panelId, topicId, updated) {
    if (updated === void 0) return false;
    return read(panelId)[topicId] === updated;
  }

  // packages/research/client/sidebar-status.ts
  var POLL_MS = 5e3;
  function countTopics(topics, isSeen) {
    const counts = { active: 0, completed: 0, incomplete: 0, failed: 0 };
    for (const topic of topics) {
      switch (topic.status) {
        case "queued":
        case "uploading":
        case "submitted":
        case "waiting":
        case "answered":
        case "adjudicating":
          counts.active += 1;
          break;
        case "completed":
          if (!isSeen(topic)) counts.completed += 1;
          break;
        case "capped":
          counts.incomplete += 1;
          break;
        case "failed":
        case "stalled":
          counts.failed += 1;
          break;
        default:
          break;
      }
    }
    return counts;
  }
  var STATUS_TINT = {
    active: "#6f9fd0",
    incomplete: "#c39a4a",
    completed: "#5f9c7a",
    failed: "#c26a6a"
  };
  function badgeParts(counts) {
    const parts = [];
    if (counts.active > 0) parts.push({ text: `${counts.active} \u8FDB\u884C`, color: STATUS_TINT.active });
    if (counts.incomplete > 0) parts.push({ text: `${counts.incomplete} \u672A\u5B8C\u6210`, color: STATUS_TINT.incomplete });
    if (counts.completed > 0) parts.push({ text: `${counts.completed} \u5B8C\u6210`, color: STATUS_TINT.completed });
    if (counts.failed > 0) parts.push({ text: `${counts.failed} \u5931\u8D25`, color: STATUS_TINT.failed });
    return parts;
  }
  function badgeText(counts) {
    return badgeParts(counts).map((part) => part.text).join(" \xB7 ");
  }
  function sidebarStatusText(topics, isSeen = () => false) {
    return badgeText(countTopics(topics, isSeen));
  }
  function mountSidebarStatus(options) {
    if (typeof document === "undefined") return () => {
    };
    let badge;
    let text = "";
    let parts = [];
    let disposed = false;
    let polling = false;
    let attachTimer;
    let observer;
    const rowFor = () => {
      const buttons = document.querySelectorAll("button[aria-label]");
      for (const button of buttons) {
        if (button.getAttribute("aria-label") === options.label) return button;
      }
      return void 0;
    };
    const renderBadge = (target) => {
      target.replaceChildren();
      parts.forEach((part, index) => {
        if (index > 0) {
          const separator = document.createElement("span");
          separator.textContent = " \xB7 ";
          separator.style.opacity = ".35";
          target.appendChild(separator);
        }
        const span = document.createElement("span");
        span.textContent = part.text;
        span.style.color = part.color;
        target.appendChild(span);
      });
      target.dataset.text = text;
    };
    const applyText = (next, nextParts) => {
      const changed = text !== next;
      text = next;
      parts = nextParts;
      if (badge !== void 0 && changed) renderBadge(badge);
      ensureMounted();
    };
    const ensureMounted = () => {
      if (disposed) return;
      if (text === "") {
        badge?.remove();
        badge = void 0;
        return;
      }
      const row = rowFor();
      if (row === void 0) return;
      const title = row.querySelector('[class*="panelTitle"]');
      if (title === null) {
        badge?.remove();
        badge = void 0;
        return;
      }
      if (badge !== void 0 && badge.parentElement === row) {
        if (badge.dataset.text !== text) renderBadge(badge);
        return;
      }
      badge = document.createElement("span");
      badge.dataset.dshProBadge = options.panelId;
      badge.setAttribute("aria-hidden", "true");
      badge.style.cssText = [
        "margin-left:auto",
        "display:inline-flex",
        "align-items:center",
        "flex:0 0 auto",
        "font-size:10px",
        "font-weight:500",
        "line-height:1",
        "opacity:.8",
        "white-space:nowrap",
        "font-variant-numeric:tabular-nums",
        "pointer-events:none"
      ].join(";");
      renderBadge(badge);
      row.appendChild(badge);
    };
    const refresh = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        const response = await fetch(`${options.routes}/topics`, { headers: { accept: "application/json" } });
        if (!response.ok) return;
        const data = await response.json();
        const counts = countTopics(
          data.topics ?? [],
          (topic) => isTopicSeen(options.panelId, topic.topic_id ?? "", topic.updated)
        );
        applyText(badgeText(counts), badgeParts(counts));
      } catch (error) {
        console.error("dsh-pro sidebar badge refresh failed", error);
      } finally {
        polling = false;
      }
    };
    observer = new MutationObserver(() => {
      if (attachTimer !== void 0) return;
      attachTimer = window.setTimeout(() => {
        attachTimer = void 0;
        ensureMounted();
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    const onSeen = () => {
      void refresh();
    };
    window.addEventListener(SEEN_EVENT, onSeen);
    void refresh();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(SEEN_EVENT, onSeen);
      if (attachTimer !== void 0) window.clearTimeout(attachTimer);
      observer?.disconnect();
      badge?.remove();
      badge = void 0;
    };
  }
  return __toCommonJS(sidebar_status_exports);
})();
