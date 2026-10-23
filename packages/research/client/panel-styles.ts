export const PANEL_CSS = `
.dshpro-host { height: 100%; min-height: 0; min-width: 0; container: dshpro / inline-size; }
.dshpro-root {
  --dshpro-accent: #4f6fd8;
  --dshpro-accent-fg: #fff;
  --dshpro-bg: var(--dsw-alias-bg-base, Canvas);
  --dshpro-panel: var(--dsw-alias-bg-layer-1, Canvas);
  --dshpro-panel-2: color-mix(in srgb, var(--dshpro-text) 3%, var(--dshpro-bg));
  --dshpro-text: var(--dsw-alias-label-primary, CanvasText);
  --dshpro-muted: color-mix(in srgb, var(--dshpro-text) 66%, var(--dshpro-bg));
  --dshpro-faint: color-mix(in srgb, var(--dshpro-text) 56%, var(--dshpro-bg));
  --dshpro-line: color-mix(in srgb, var(--dshpro-text) 12%, var(--dshpro-bg));
  --dshpro-line-strong: var(--dsw-alias-border-l3, rgba(127,127,127,.32));
  --dshpro-hover: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.09));
  --dshpro-success: #2e7d32;
  --dshpro-error: #c62828;
  --dshpro-warn: #b45309;
  --dshpro-info: #356faf;
  --dshpro-capped: #6f3fa8;
  --dshpro-radius: 8px;
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dshpro-bg);
  color: var(--dshpro-text);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif);
  font-size: 13px;
  line-height: 1.5;
}
.dshpro-root[data-plugin="design"] { --dshpro-accent: #b26a12; }
body[data-ds-dark-theme] .dshpro-root {
  --dshpro-accent-fg: #101114;
  --dshpro-success: #85ba98;
  --dshpro-error: #e79898;
  --dshpro-warn: #dbb078;
  --dshpro-info: #93c5fd;
  --dshpro-capped: #c4a5ff;
}
body[data-ds-dark-theme] .dshpro-root[data-plugin="research"] { --dshpro-accent: #7f9cff; }
body[data-ds-dark-theme] .dshpro-root[data-plugin="design"] { --dshpro-accent: #d79a4f; }
.dshpro-root, .dshpro-root *, .dshpro-root *::before, .dshpro-root *::after { box-sizing: border-box; }
.dshpro-root :where(button, input, textarea) { font: inherit; color: inherit; }
.dshpro-root button { cursor: pointer; }
.dshpro-root [data-tone="success"] { --tone-color: var(--dshpro-success); }
.dshpro-root [data-tone="capped"] { --tone-color: var(--dshpro-capped); }
.dshpro-root [data-tone="review"] { --tone-color: var(--dshpro-info); }
.dshpro-root [data-tone="warn"] { --tone-color: var(--dshpro-warn); }
.dshpro-root [data-tone="error"] { --tone-color: var(--dshpro-error); }
.dshpro-root [data-tone="active"] { --tone-color: #6f8fbf; }
.dshpro-root [data-tone="muted"] { --tone-color: var(--dshpro-faint); }

.dshpro-list {
  width: 288px;
  flex: 0 0 288px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--dshpro-line);
  background: var(--dshpro-panel-2);
}
.dshpro-list-head { padding: 22px 16px 16px; border-bottom: 1px solid var(--dshpro-line); }
.dshpro-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshpro-brand-mark {
  width: 27px; height: 27px; flex: none; display: grid; place-items: center;
  border: 1px solid color-mix(in srgb, var(--dshpro-accent) 30%, var(--dshpro-line));
  border-radius: 7px; background: color-mix(in srgb, var(--dshpro-accent) 11%, var(--dshpro-panel));
  color: var(--dshpro-accent); font-size: 12px; font-weight: 800;
}
.dshpro-brand-info { min-width: 0; flex: 1; }
.dshpro-brand-title { font-size: 14px; font-weight: 650; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshpro-brand-sub { margin-top: 1px; color: var(--dshpro-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshpro-count {
  flex: none; min-width: 22px; text-align: center; padding: 1px 6px;
  border: 1px solid var(--dshpro-line); border-radius: 999px;
  color: var(--dshpro-muted); font-size: 11px; font-variant-numeric: tabular-nums;
}
.dshpro-search {
  display: flex; align-items: center; gap: 6px; height: 34px; margin-top: 18px;
  padding: 0 8px; border: 1px solid var(--dshpro-line); border-radius: 6px;
  background: var(--dshpro-panel); color: var(--dshpro-muted);
}
.dshpro-search:focus-within { border-color: var(--dshpro-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshpro-accent) 14%, transparent); }
.dshpro-search input { flex: 1; min-width: 0; height: 28px; padding: 0; border: 0; outline: 0; background: transparent; color: var(--dshpro-text); font-size: 12px; }
.dshpro-search input::placeholder { color: var(--dshpro-faint); }
.dshpro-filters { display: flex; gap: 2px; flex-wrap: wrap; margin-top: 7px; }
.dshpro-filter {
  flex: 1; justify-content: center; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; padding: 4px 5px;
  border: 1px solid transparent; border-radius: 5px; background: transparent;
  color: var(--dshpro-muted); font-size: 12px;
}
.dshpro-filter:hover { background: var(--dshpro-hover); }
.dshpro-filter.is-on { border-color: color-mix(in srgb, var(--dshpro-accent) 28%, var(--dshpro-line)); background: var(--dshpro-panel); color: var(--dshpro-text); }
.dshpro-filter span { color: var(--dshpro-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.dshpro-list-scroll { flex: 1; min-height: 0; overflow: auto; padding: 10px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,.35)) transparent; }
.dshpro-topic {
  display: block; position: relative; width: 100%; margin: 0 0 3px; padding: 13px 12px 12px 15px;
  border: 1px solid transparent; border-radius: 7px; background: transparent;
  color: var(--dshpro-text); text-align: left;
}
.dshpro-topic:hover { background: var(--dshpro-hover); }
.dshpro-topic.is-selected { background: color-mix(in srgb, var(--dshpro-accent) 10%, var(--dshpro-panel)); border-color: color-mix(in srgb, var(--dshpro-accent) 32%, var(--dshpro-line)); }
.dshpro-topic-bar {
  position: absolute; left: 0; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0;
  background: transparent; opacity: .6;
}
.dshpro-topic.is-selected .dshpro-topic-bar { background: var(--dshpro-accent); opacity: 1; }
.dshpro-topic-title {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font-size: 13px; font-weight: 600; line-height: 1.55; overflow-wrap: anywhere;
}
.dshpro-topic-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
  margin-top: 4px; color: var(--dshpro-muted); font-size: 12px;
}
.dshpro-topic-meta .dshpro-sep { color: var(--dshpro-faint); opacity: .7; }
.dshpro-topic-tail { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; }
.dshpro-topic-artifacts { display: inline-flex; align-items: center; gap: 2px; color: var(--dshpro-faint); font-size: 11px; }
.dshpro-dot { width: 7px; height: 7px; flex: none; border-radius: 999px; background: var(--tone-color, var(--dshpro-faint)); }
.dshpro-status-text { color: var(--tone-color, var(--dshpro-muted)); font-weight: 650; }
.dshpro-badge {
  display: inline-flex; align-items: center; padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--tone-color) 38%, transparent);
  border-radius: 4px; background: color-mix(in srgb, var(--tone-color) 10%, transparent);
  color: var(--tone-color); font-size: 11px; font-weight: 650; white-space: nowrap;
}
.dshpro-list-empty { padding: 28px 16px; text-align: center; color: var(--dshpro-muted); }
.dshpro-list-empty .dshpro-empty-icon { margin: 0 auto 8px; color: var(--dshpro-faint); }
.dshpro-list-empty p { margin: 0; font-size: 12.5px; font-weight: 650; color: var(--dshpro-text); }
.dshpro-list-empty span { display: block; margin-top: 4px; font-size: 12px; line-height: 1.5; }
.dshpro-list-empty button { margin-top: 8px; }
.dshpro-list-error { margin: 8px; padding: 8px; border: 1px solid color-mix(in srgb, var(--dshpro-error) 30%, var(--dshpro-line)); border-radius: 6px; background: color-mix(in srgb, var(--dshpro-error) 7%, var(--dshpro-panel)); color: var(--dshpro-error); font-size: 12px; }
.dshpro-skeleton { border-radius: 4px; background: linear-gradient(90deg, var(--dshpro-hover), color-mix(in srgb, var(--dshpro-hover) 45%, transparent), var(--dshpro-hover)); background-size: 200% 100%; animation: dshpro-shimmer 1.4s ease-in-out infinite; }
@keyframes dshpro-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.dshpro-list-skeleton { padding: 8px 8px 8px 17px; }

.dshpro-detail { flex: 1; min-width: 0; overflow: auto; padding: 28px 32px 48px; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,.35)) transparent; }
.dshpro-error-banner {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--dshpro-error) 35%, var(--dshpro-line)); border-radius: 7px;
  background: color-mix(in srgb, var(--dshpro-error) 8%, var(--dshpro-panel)); color: var(--dshpro-error); font-size: 11px;
}
.dshpro-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 20px;
  margin-bottom: 24px; padding: 0; min-width: 0;
}
.dshpro-head-info { min-width: 0; flex: 1; }
.dshpro-title-row { display: flex; align-items: flex-start; gap: 9px; flex-wrap: wrap; }
.dshpro-title { margin: 0; max-width: 900px; color: var(--dshpro-text); font-size: 22px; font-weight: 650; line-height: 1.4; letter-spacing: -.35px; overflow-wrap: anywhere; }
.dshpro-status { flex: none; padding: 2px 6px; border: 1px solid color-mix(in srgb, var(--tone-color) 50%, transparent); border-radius: 5px; color: var(--tone-color); font-size: 11px; font-weight: 700; line-height: 1.35; white-space: nowrap; }
.dshpro-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 10px; color: var(--dshpro-muted); font-size: 12px; }
.dshpro-meta > span:not(:first-child)::before { content: "·"; margin-right: 6px; color: var(--dshpro-faint); opacity: .7; }
.dshpro-path { display: flex; align-items: center; gap: 5px; min-width: 0; margin-top: 7px; color: var(--dshpro-faint); font-size: 11px; }
.dshpro-path span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.dshpro-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--dshpro-muted); }
.dshpro-icon-btn:hover { border-color: var(--dshpro-line); background: var(--dshpro-hover); color: var(--dshpro-text); }
.dshpro-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; max-width: 420px; padding-top: 22px; }
.dshpro-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 32px; padding: 6px 11px; border: 1px solid var(--dshpro-line);
  border-radius: 6px; background: var(--dshpro-panel); color: var(--dshpro-text);
  font-size: 12px; line-height: 1.2; text-decoration: none; white-space: nowrap;
}
.dshpro-btn:hover { background: var(--dshpro-hover); }
.dshpro-btn:disabled { opacity: .55; cursor: default; }
.dshpro-btn.primary { border-color: var(--dshpro-accent); background: var(--dshpro-accent); color: var(--dshpro-accent-fg); font-weight: 650; }
.dshpro-btn.primary:hover { filter: brightness(.96); }
.dshpro-btn.danger { border-color: color-mix(in srgb, var(--dshpro-error) 42%, var(--dshpro-line)); color: var(--dshpro-error); }
.dshpro-btn.ghost { border-color: transparent; background: transparent; color: var(--dshpro-muted); }
.dshpro-btn.ghost:hover { color: var(--dshpro-text); background: var(--dshpro-hover); }
.dshpro-btn.small { min-height: 28px; padding: 4px 8px; font-size: 12px; }
.dshpro-more { position: relative; }
.dshpro-more summary { list-style: none; }
.dshpro-more summary::-webkit-details-marker { display: none; }
.dshpro-menu {
  position: absolute; right: 0; top: calc(100% + 4px); z-index: 12; min-width: 160px;
  display: flex; flex-direction: column; gap: 1px; padding: 4px;
  border: 1px solid var(--dshpro-line); border-radius: 7px; background: var(--dshpro-panel);
  box-shadow: 0 10px 30px rgba(0,0,0,.18);
}
.dshpro-menu button { padding: 6px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--dshpro-text); text-align: left; font-size: 12px; }
.dshpro-menu button:hover { background: var(--dshpro-hover); }

.dshpro-banner {
  display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; padding: 9px 11px;
  border: 1px solid color-mix(in srgb, var(--tone-color) 32%, var(--dshpro-line)); border-radius: 7px;
  background: color-mix(in srgb, var(--tone-color) 7%, var(--dshpro-panel)); color: var(--dshpro-muted); font-size: 12px;
}
.dshpro-banner strong { color: var(--tone-color); font-weight: 700; }
.dshpro-banner .dshpro-check-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-left: auto; }
.dshpro-banner .dshpro-check-actions span { color: var(--dshpro-faint); font-size: 12px; }
.dshpro-tabs { position: sticky; top: -1px; z-index: 1; background: var(--dshpro-bg); display: flex; align-items: center; gap: 2px; margin: 0 0 24px; border-bottom: 1px solid var(--dshpro-line); overflow: auto; }
.dshpro-tab { padding: 12px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--dshpro-muted); font-size: 12px; white-space: nowrap; }
.dshpro-tab:hover { color: var(--dshpro-text); }
.dshpro-tab.is-on { border-bottom-color: var(--dshpro-accent); color: var(--dshpro-text); font-weight: 700; }
.dshpro-tab em { margin-left: 4px; color: var(--dshpro-faint); font-style: normal; font-size: 11px; font-variant-numeric: tabular-nums; }
.dshpro-body { display: grid; grid-template-columns: minmax(0, 1fr) 256px; gap: 28px; align-items: start; }
.dshpro-main, .dshpro-rail { min-width: 0; }
.dshpro-card { margin-bottom: 12px; padding: 18px; border: 1px solid var(--dshpro-line); border-radius: var(--dshpro-radius); background: var(--dshpro-panel); min-width: 0; }
.dshpro-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.dshpro-card-title { margin: 0; font-size: 13px; font-weight: 650; line-height: 1.35; }
.dshpro-card-sub { margin-top: 1px; color: var(--dshpro-muted); font-size: 12px; }
.dshpro-muted { color: var(--dshpro-muted); }
.dshpro-faint { color: var(--dshpro-faint); }
.dshpro-card-link { border: 0; background: transparent; color: var(--dshpro-muted); font-size: 12px; }
.dshpro-card-link:hover { color: var(--dshpro-accent); }
.dshpro-empty-inline { padding: 14px 0; color: var(--dshpro-faint); font-size: 12px; text-align: center; }
.dshpro-empty-detail { display: flex; height: 100%; min-height: 260px; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--dshpro-muted); text-align: center; }
.dshpro-empty-detail .dshpro-empty-mark { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid var(--dshpro-line); border-radius: 10px; background: var(--dshpro-panel-2); color: var(--dshpro-accent); }
.dshpro-empty-detail strong { color: var(--dshpro-text); font-size: 13px; }
.dshpro-empty-detail span { font-size: 11px; max-width: 320px; line-height: 1.5; }

.dshpro-final { display: flex; align-items: center; gap: 10px; padding: 10px; border: 1px solid color-mix(in srgb, var(--dshpro-accent) 28%, var(--dshpro-line)); border-radius: 8px; background: var(--dshpro-panel-2); }
.dshpro-final-icon { width: 34px; height: 38px; flex: none; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--dshpro-accent) 25%, var(--dshpro-line)); border-radius: 6px; background: var(--dshpro-panel); color: var(--dshpro-accent); }
.dshpro-final-info { flex: 1; min-width: 0; }
.dshpro-final-title { font-size: 12px; font-weight: 700; }
.dshpro-final-path { margin-top: 1px; color: var(--dshpro-muted); font-size: 11px; font-family: ui-monospace, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshpro-final-desc { margin-top: 2px; color: var(--dshpro-faint); font-size: 11px; }

.dshpro-table-wrap { width: 100%; overflow-x: auto; }
.dshpro-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.dshpro-table th { padding: 6px 7px; border-bottom: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); color: var(--dshpro-muted); font-size: 11px; font-weight: 600; text-align: left; white-space: nowrap; }
.dshpro-table td { padding: 7px; border-bottom: 1px solid color-mix(in srgb, var(--dshpro-line) 65%, transparent); vertical-align: top; }
.dshpro-table tr:last-child td { border-bottom: 0; }
.dshpro-table .dshpro-num { font-variant-numeric: tabular-nums; font-weight: 650; white-space: nowrap; }
.dshpro-table .dshpro-nowrap { white-space: nowrap; }
.dshpro-table .dshpro-dim { color: var(--dshpro-muted); }
.dshpro-verdict { font-weight: 650; }
.dshpro-verdict[data-verdict="accepted"] { color: var(--dshpro-success); }
.dshpro-verdict[data-verdict="partial"] { color: #b58a2b; }
.dshpro-verdict[data-verdict="rejected"] { color: var(--dshpro-error); }
.dshpro-verdict[data-verdict="answered"] { color: var(--dshpro-info); }
.dshpro-verdict[data-verdict="pending"] { color: var(--dshpro-faint); }
.dshpro-artifacts-cell { padding: 0 7px 9px; }
.dshpro-thumbs { display: flex; gap: 6px; flex-wrap: wrap; padding-top: 6px; }
.dshpro-thumb { width: 132px; height: 84px; padding: 0; overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 6px; background: var(--dshpro-panel-2); cursor: zoom-in; }
.dshpro-thumb img { width: 100%; height: 100%; display: block; object-fit: contain; }
.dshpro-thumb:hover { border-color: var(--dshpro-accent); }
.dshpro-chips { display: flex; gap: 5px; flex-wrap: wrap; padding-top: 6px; }
.dshpro-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border: 1px solid var(--dshpro-line); border-radius: 4px; background: transparent; color: var(--dshpro-muted); font-size: 11px; text-decoration: none; }
.dshpro-chip:hover { border-color: var(--dshpro-accent); color: var(--dshpro-accent); }
.dshpro-round-card { margin-bottom: 12px; padding: 18px; border: 1px solid var(--dshpro-line); border-radius: var(--dshpro-radius); background: var(--dshpro-panel); }
.dshpro-round-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.dshpro-round-title { font-size: 12.5px; font-weight: 700; }
.dshpro-round-sub { margin-top: 2px; color: var(--dshpro-muted); font-size: 12px; }

.dshpro-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr)); gap: 18px; }
.dshpro-art { position: relative; display: block; width: 100%; padding: 0; overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 7px; background: var(--dshpro-panel-2); aspect-ratio: 4 / 3; cursor: zoom-in; border: 0; border-radius: 0; }
.dshpro-art img { width: 100%; height: 100%; display: block; object-fit: contain; }
.dshpro-art:hover { border-color: var(--dshpro-accent); }
.dshpro-art-label { position: absolute; left: 0; right: 0; bottom: 0; padding: 5px 7px; background: linear-gradient(0deg, rgba(0,0,0,.5), transparent); color: #fff; font-size: 9px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshpro-art-round { position: absolute; top: 4px; right: 4px; padding: 1px 3px; border-radius: 3px; background: rgba(15,17,21,.62); color: #fff; font-size: 8px; font-weight: 700; line-height: 1.3; }
.dshpro-mini-gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.dshpro-mini-gallery .dshpro-art { aspect-ratio: 4 / 3; }

.dshpro-file-list { display: flex; flex-direction: column; }
.dshpro-file { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--dshpro-line) 65%, transparent); }
.dshpro-file:first-child { border-top: 0; }
.dshpro-file-icon { width: 29px; height: 31px; flex: none; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--dshpro-accent) 20%, var(--dshpro-line)); border-radius: 5px; background: color-mix(in srgb, var(--dshpro-accent) 8%, var(--dshpro-panel)); color: var(--dshpro-accent); }
.dshpro-file-info { flex: 1; min-width: 0; }
.dshpro-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 650; }
.dshpro-file-path { overflow-wrap: anywhere; color: var(--dshpro-faint); font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
.dshpro-file-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dshpro-file-actions .dshpro-btn { min-height: 22px; padding: 2px 6px; font-size: 11px; }

.dshpro-demo { overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 8px; background: var(--dshpro-panel); }
.dshpro-demo-preview { border-bottom: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); }
.dshpro-demo-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--dshpro-line); background: var(--dshpro-panel); color: var(--dshpro-faint); font-size: 9px; }
.dshpro-demo-bar i { width: 5px; height: 5px; border-radius: 999px; background: currentColor; opacity: .5; }
.dshpro-demo-bar em { margin-left: auto; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; }
.dshpro-demo-canvas { display: grid; place-items: center; min-height: 100px; background: linear-gradient(135deg, color-mix(in srgb, var(--dshpro-accent) 12%, var(--dshpro-panel)), var(--dshpro-panel-2) 62%, color-mix(in srgb, var(--dshpro-warn) 9%, var(--dshpro-panel))); color: var(--dshpro-muted); font-size: 11px; }
.dshpro-demo-meta { display: flex; align-items: center; gap: 12px; padding: 14px; flex-wrap: wrap; }
.dshpro-demo-meta .dshpro-file-info { flex: 1; }
.dshpro-demo-actions { display: flex; gap: 4px; flex: none; }
.dshpro-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 10px; font-size: 12px; }
.dshpro-meta-grid span { display: block; color: var(--dshpro-faint); }
.dshpro-meta-grid b { display: block; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; color: var(--dshpro-muted); }

.dshpro-toast { position: fixed; right: 18px; bottom: 18px; z-index: 2147483100; max-width: min(420px, calc(100vw - 36px)); padding: 9px 12px; border-radius: 7px; background: var(--dshpro-text); color: var(--dshpro-panel); box-shadow: 0 10px 28px rgba(0,0,0,.25); font-size: 12px; line-height: 1.45; }
.dshpro-toast[data-kind="error"] { background: var(--dshpro-error); color: #fff; }
.dshpro-overlay { position: fixed; inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; border: 0; z-index: 2147482900; align-items: center; justify-content: center; padding: 22px; background: transparent; color: inherit; }
.dshpro-overlay[open] { display: flex; }
.dshpro-overlay::backdrop { background: rgba(0,0,0,.5); }
.dshpro-overlay.is-viewer { z-index: 2147483000; padding: 18px; }
.dshpro-modal-card { display: flex; flex-direction: column; width: min(920px, 94vw); max-height: 90vh; overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 10px; background: var(--dshpro-panel); color: var(--dshpro-text); box-shadow: 0 24px 80px rgba(0,0,0,.42); }
.dshpro-modal-card.is-dialog { width: min(520px, 94vw); }
.dshpro-modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dshpro-line); }
.dshpro-modal-head .dshpro-modal-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 700; }
.dshpro-modal-body { flex: 1; min-height: 0; overflow: auto; }
.dshpro-modal-body img { display: block; max-width: 100%; max-height: 70vh; margin: 0 auto; object-fit: contain; }
.dshpro-modal-body iframe { display: block; width: 100%; height: 70vh; border: 0; background: #fff; }
.dshpro-modal-body pre { margin: 0; padding: 14px; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.55; }
.dshpro-modal-foot { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); }
.dshpro-modal-note { margin-left: auto; color: var(--dshpro-muted); font-size: 11px; }
.dshpro-dialog-body { padding: 20px; margin: 0; min-width: 0; border: 0; }
.dshpro-dialog-body label { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 650; }
.dshpro-dialog-body p { margin: 0 0 8px; color: var(--dshpro-muted); font-size: 11px; line-height: 1.5; }
.dshpro-dialog-body textarea { width: 100%; min-height: 82px; resize: vertical; padding: 7px 9px; border: 1px solid var(--dshpro-line); border-radius: 6px; outline: 0; background: var(--dshpro-bg); color: var(--dshpro-text); font-size: 12px; line-height: 1.5; }
.dshpro-dialog-body textarea:focus { border-color: var(--dshpro-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshpro-accent) 13%, transparent); }
.dshpro-dialog-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; color: var(--dshpro-muted); font-size: 11px; }
.dshpro-dialog-row input { width: 62px; padding: 5px 7px; border: 1px solid var(--dshpro-line); border-radius: 5px; background: var(--dshpro-bg); color: var(--dshpro-text); }
.dshpro-dialog-foot { display: flex; justify-content: flex-end; gap: 6px; padding: 10px 14px; border-top: 1px solid var(--dshpro-line); background: var(--dshpro-panel-2); }
.dshpro-dialog-foot .dshpro-btn { min-height: 28px; padding: 4px 11px; }

/* Local layout follows the plugin's available width, excluding the host sidebar. */
@container dshpro (max-width: 1199px) {
  .dshpro-head { flex-direction: column; gap: 10px; }
  .dshpro-actions { padding-top: 0; max-width: none; justify-content: flex-start; }
  .dshpro-body { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .dshpro-rail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
  .dshpro-activity { grid-row: span 2; }
}
@container dshpro (max-width: 959px) {
  .dshpro-list { width: 256px; flex-basis: 256px; }
  .dshpro-list-head { padding: 18px 12px 12px; }
  .dshpro-detail { padding: 22px 20px 36px; }
  .dshpro-title { font-size: 20px; }
  .dshpro-filter { font-size: 11px; gap: 3px; padding-inline: 3px; }
  .dshpro-rail { display: block; }
  .dshpro-rail > * { margin-bottom: 20px; }
}
@container dshpro (max-width: 719px) {
  .dshpro-root { display: block; }
  .dshpro-list { width: 100%; height: 100%; border-right: 0; }
  .dshpro-detail { display: none; height: 100%; padding: 16px; }
  .dshpro-root[data-mobile-detail="true"] > .dshpro-list { display: none; }
  .dshpro-root[data-mobile-detail="true"] > .dshpro-detail { display: block; }
  .dshpro-back { display: inline-flex !important; margin-bottom: 20px; }
  .dshpro-head { margin-bottom: 16px; }
  .dshpro-list-head { padding: 20px 18px 16px; }
  .dshpro-filters { max-width: 400px; }
  .dshpro-filter { font-size: 12px; }
  .dshpro-document-card { padding: 18px !important; }
  .dshpro-section-heading { gap: 12px; flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  .dshpro-skeleton { animation: none; }
}

.dshpro-root :is(button, a, summary, input, textarea, [tabindex]):focus-visible { outline: 2px solid var(--dshpro-accent); outline-offset: 3px; }
.dshpro-root button:disabled { cursor: default; opacity: .55; }
.dshpro-back { display: none; }
.dshpro-eyebrow { display: block; margin-bottom: 9px; color: var(--dshpro-muted); font-size: 11px; letter-spacing: .5px; }
.dshpro-eyebrow span { color: var(--dshpro-faint); }
.dshpro-topic-foot { display: flex; gap: 10px; margin-top: 8px; color: var(--dshpro-faint); font-size: 11px; }
.dshpro-topic-meta { margin-top: 7px; }
.dshpro-topic-artifacts { font-size: 11px; gap: 4px; }
.dshpro-topic[data-tone="error"] .dshpro-topic-bar, .dshpro-topic[data-tone="warn"] .dshpro-topic-bar { background: var(--tone-color); }
.dshpro-title-row { align-items: center; }
.dshpro-body[data-view="rounds"], .dshpro-body[data-view="artifacts"] { grid-template-columns: minmax(0, 1fr); }
.dshpro-document-card { border: 1px solid var(--dshpro-line); border-radius: 10px; padding: 26px 30px; background: var(--dshpro-panel); min-width: 0; }
.dshpro-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 18px; margin-bottom: 20px; }
.dshpro-section-heading h3 { font-size: 16px; line-height: 1.5; font-weight: 650; margin: 0; }
.dshpro-section-heading .dshpro-eyebrow { margin-bottom: 4px; }
.dshpro-document-context { color: var(--dshpro-muted); border-bottom: 1px solid var(--dshpro-line); padding-bottom: 18px; font-size: 12px; line-height: 1.7; }
.dshpro-document { max-width: 78ch; margin: 24px auto 0; font-size: 14px; line-height: 1.85; overflow-wrap: anywhere; }
.dshpro-document p { margin: 0 0 16px; white-space: pre-wrap; }
.dshpro-document h2 { font-size: 21px; line-height: 1.55; font-weight: 650; margin: 28px 0 16px; }
.dshpro-document h3 { font-size: 17px; line-height: 1.6; font-weight: 650; margin: 24px 0 12px; }
.dshpro-document h4 { font-size: 14px; margin: 20px 0 10px; }
.dshpro-document > :first-child { margin-top: 0; }
.dshpro-document ul, .dshpro-document ol { padding-left: 24px; margin: 12px 0 20px; }
.dshpro-document li { margin-bottom: 7px; }
.dshpro-document strong { font-weight: 650; }
.dshpro-document code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--dshpro-panel-2); border-radius: 3px; padding: 2px 4px; font-size: .9em; }
.dshpro-document pre { white-space: pre-wrap; background: var(--dshpro-panel-2); border: 1px solid var(--dshpro-line); padding: 14px; border-radius: 6px; line-height: 1.65; }
.dshpro-document pre code { background: transparent; padding: 0; }
.dshpro-document blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid var(--dshpro-accent); color: var(--dshpro-muted); white-space: pre-wrap; }
.dshpro-document hr { border: 0; border-top: 1px solid var(--dshpro-line); margin: 24px 0; }
.dshpro-document-table { overflow: auto; margin: 20px 0; }
.dshpro-document table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshpro-document th, .dshpro-document td { padding: 9px 10px; text-align: left; border-bottom: 1px solid var(--dshpro-line); min-width: 90px; }
.dshpro-document th { color: var(--dshpro-muted); font-weight: 600; }
.dshpro-document-loading { padding: 28px 0; }
.dshpro-document-loading .dshpro-skeleton { height: 14px; margin-bottom: 18px; width: 95%; }
.dshpro-document-loading .dshpro-skeleton:last-child { width: 65%; }
.dshpro-content-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 56px 16px; text-align: center; color: var(--dshpro-muted); font-size: 12px; }
.dshpro-content-empty strong { color: var(--dshpro-text); font-weight: 600; font-size: 14px; }
.dshpro-content-empty > svg { color: var(--dshpro-faint); margin-bottom: 8px; }
.dshpro-activity { padding: 4px 0 0; }
.dshpro-activity ol { list-style: none; padding: 0; margin: 20px 0 0; }
.dshpro-activity li { position: relative; margin-left: 4px; padding: 0 0 24px 17px; border-left: 1px solid var(--dshpro-line); }
.dshpro-activity li:last-child { border-color: transparent; padding-bottom: 10px; }
.dshpro-activity-dot { position: absolute; top: 6px; left: -3px; width: 5px; height: 5px; border-radius: 50%; background: var(--dshpro-faint); }
.dshpro-activity-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.dshpro-activity-heading strong { font-weight: 600; }
.dshpro-activity time { display: block; margin-top: 6px; font-size: 11px; color: var(--dshpro-faint); }
.dshpro-activity-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--dshpro-muted); font-size: 11px; }
.dshpro-card-link { display: inline-flex; align-items: center; gap: 4px; padding: 3px 0; font-size: 12px; }
.dshpro-artifact-index { width: 100%; padding: 16px 0; margin: 8px 0 16px; display: flex; align-items: center; gap: 12px; text-align: left; background: transparent; border: 0; border-block: 1px solid var(--dshpro-line); }
.dshpro-artifact-index span { flex: 1; font-size: 13px; font-weight: 600; }
.dshpro-artifact-index small { display: block; margin-top: 4px; font-size: 11px; color: var(--dshpro-muted); font-weight: 400; }
.dshpro-context summary { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px; color: var(--dshpro-muted); padding: 8px 0; list-style: none; }
.dshpro-context summary::-webkit-details-marker { display: none; }
.dshpro-context summary svg:last-child { margin-left: auto; }
.dshpro-context[open] summary svg:last-child { transform: rotate(90deg); }
.dshpro-context-body { padding-top: 12px; }
.dshpro-meta-grid { margin: 0; row-gap: 14px; font-size: 12px; }
.dshpro-meta-grid dt { color: var(--dshpro-faint); }
.dshpro-meta-grid dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.dshpro-context-note { font-size: 12px; line-height: 1.65; color: var(--dshpro-muted); margin: 16px 0; }
.dshpro-context-path { color: var(--dshpro-faint); font-size: 11px; overflow-wrap: anywhere; }
.dshpro-context-path > span { display: block; margin: 10px 0; }
.dshpro-design-sheet { margin-bottom: 24px; }
.dshpro-art-frame { overflow: hidden; border: 1px solid var(--dshpro-line); border-radius: 8px; min-width: 0; }
.dshpro-art-caption { padding: 10px 12px; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dshpro-muted); background: var(--dshpro-panel); }
.dshpro-art-caption span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshpro-image-error { min-height: 180px; aspect-ratio: 4 / 3; display: flex; flex-direction: column; gap: 10px; align-items: center; justify-content: center; color: var(--dshpro-muted); background: var(--dshpro-panel-2); font-size: 12px; }
.dshpro-modal-body { overscroll-behavior: contain; }
.dshpro-modal-head { padding: 14px 18px; }
.dshpro-modal-head .dshpro-modal-title { font-size: 14px; }
.dshpro-icon-btn { width: 28px; height: 28px; flex: none; }
.dshpro-modal-body pre { font-size: 13px; padding: 24px; line-height: 1.75; }
.dshpro-dialog-feedback { margin: 0 20px 16px; color: var(--dshpro-muted); font-size: 12px; }
.dshpro-dialog-feedback[data-kind="error"] { color: var(--dshpro-error); }
`
