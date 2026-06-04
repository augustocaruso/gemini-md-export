// @ts-nocheck
(function () {
    'use strict';
      // ============================================================
  // Inlined from src/browser/shared/host-palette.ts (auto-generated — do not edit)
  // ============================================================
  const FONT_STACK = '"Google Sans Text","Google Sans",Roboto,"Segoe UI",system-ui,sans-serif';
  const computedStyleFor = (documentRef, element) => {
      try {
          return documentRef.defaultView?.getComputedStyle(element) || getComputedStyle(element);
      }
      catch {
          return null;
      }
  };
  const readHostCssToken = (name, fallback = '', { documentRef = document } = {}) => {
      const htmlValue = computedStyleFor(documentRef, documentRef.documentElement)
          ?.getPropertyValue(name)
          ?.trim();
      if (htmlValue)
          return htmlValue;
      const body = documentRef.body;
      if (body) {
          const bodyValue = computedStyleFor(documentRef, body)?.getPropertyValue(name)?.trim();
          if (bodyValue)
              return bodyValue;
      }
      return fallback;
  };
  const buildHostPalette = ({ documentRef = document, isDark = false, } = {}) => {
      const surfaceContainerHigh = readHostCssToken('--gem-sys-color--surface-container-high', isDark ? '#282a2c' : '#ffffff', { documentRef });
      const surfaceContainerHighest = readHostCssToken('--gem-sys-color--surface-container-highest', isDark ? '#333537' : '#f8fafd', { documentRef });
      const surfaceContainer = readHostCssToken('--gem-sys-color--surface-container', isDark ? '#1e1f20' : '#f0f4f9', { documentRef });
      const onSurface = readHostCssToken('--gem-sys-color--on-surface', isDark ? '#e3e3e3' : '#1f1f1f', { documentRef });
      const outline = readHostCssToken('--gem-sys-color--outline', isDark ? '#8e918f' : '#74777f', {
          documentRef,
      });
      const outlineVariant = readHostCssToken('--gem-sys-color--outline-variant', isDark ? '#444746' : '#c4c7c5', { documentRef });
      const primary = readHostCssToken('--gem-sys-color--primary', isDark ? '#a8c7fa' : '#0b57d0', {
          documentRef,
      });
      const onPrimary = readHostCssToken('--gem-sys-color--on-primary', isDark ? '#062e6f' : '#ffffff', { documentRef });
      const secondaryContainer = readHostCssToken('--gem-sys-color--secondary-container', isDark ? '#004a77' : '#c2e7ff', { documentRef });
      const onSecondaryContainer = readHostCssToken('--gem-sys-color--on-secondary-container', isDark ? '#c2e7ff' : '#001d35', { documentRef });
      return {
          '--gm-panel-bg': surfaceContainerHigh,
          '--gm-surface-elevated': surfaceContainerHighest,
          '--gm-surface-muted': surfaceContainer,
          '--gm-border': outlineVariant,
          '--gm-border-strong': outline,
          '--gm-text': onSurface,
          '--gm-text-muted': isDark
              ? `color-mix(in srgb, ${onSurface} 65%, transparent)`
              : `color-mix(in srgb, ${onSurface} 60%, transparent)`,
          '--gm-accent': primary,
          '--gm-accent-strong': secondaryContainer,
          '--gm-accent-text': onPrimary,
          '--gm-accent-on-strong': onSecondaryContainer,
          '--gm-success': isDark ? '#a6d4a6' : '#137333',
          '--gm-badge-bg': secondaryContainer,
          '--gm-badge-text': onSecondaryContainer,
          '--gm-font': FONT_STACK,
      };
  };
  const buildDockHostPalette = (options = {}) => {
      const isDark = options.isDark === true;
      const palette = buildHostPalette(options);
      return {
          '--gm-dock-bg': palette['--gm-panel-bg'],
          '--gm-dock-text': palette['--gm-text'],
          '--gm-dock-muted': palette['--gm-text-muted'],
          '--gm-dock-border': palette['--gm-border'],
          '--gm-dock-track': isDark ? 'rgba(255,255,255,0.08)' : 'rgba(60,64,67,0.12)',
          '--gm-dock-done-bg': palette['--gm-accent-strong'],
          '--gm-font': palette['--gm-font'],
          '--gm-accent': palette['--gm-accent'],
      };
  };
  const buildMenuHostPalette = (options = {}) => {
      const isDark = options.isDark === true;
      const palette = buildHostPalette(options);
      return {
          '--gm-menu-bg': palette['--gm-panel-bg'],
          '--gm-menu-text': palette['--gm-text'],
          '--gm-menu-muted': palette['--gm-text-muted'],
          '--gm-menu-border': palette['--gm-border'],
          '--gm-menu-divider': palette['--gm-border'],
          '--gm-menu-hover': isDark
              ? `color-mix(in srgb, ${palette['--gm-text']} 8%, transparent)`
              : `color-mix(in srgb, ${palette['--gm-text']} 6%, transparent)`,
          '--gm-menu-focus': `color-mix(in srgb, ${palette['--gm-accent']} 22%, transparent)`,
          '--gm-menu-pressed': isDark
              ? `color-mix(in srgb, ${palette['--gm-text']} 12%, transparent)`
              : `color-mix(in srgb, ${palette['--gm-text']} 10%, transparent)`,
          '--gm-menu-shadow': isDark
              ? '0 16px 36px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30)'
              : '0 16px 36px rgba(60,64,67,0.20), 0 2px 8px rgba(60,64,67,0.12)',
          '--gm-menu-accent': palette['--gm-accent'],
          '--gm-menu-font': palette['--gm-font'],
      };
  };
  const applyCssVars = (element, vars) => {
      Object.entries(vars).forEach(([key, value]) => element.style.setProperty(key, value));
  };

  // ============================================================
  // Inlined from src/browser/shared/native-style-profile.ts (auto-generated — do not edit)
  // ============================================================
  const GEMINI_NATIVE_STYLE_PROFILE_VERSION = 1;
  const GEMINI_LR26_NATIVE_STYLE_PROFILE = {
      name: 'gemini-lr26-dia-native',
      version: GEMINI_NATIVE_STYLE_PROFILE_VERSION,
      source: 'native-style-capture:playwright-computed-style:2026-05-23T20:54:00.000Z',
      cssVars: {
          '--gmn-topbar-slot-size': '40px',
          '--gmn-topbar-button-size': '40px',
          '--gmn-topbar-button-padding': '10px',
          '--gmn-topbar-icon-size': '20px',
          '--gmn-topbar-radius': '9999px',
          '--gmn-topbar-state-hover': 'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.08))',
          '--gmn-topbar-state-focus': 'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.10))',
          '--gmn-topbar-state-pressed': 'var(--gem-sys-color--surface-container-highest, rgba(232, 234, 237, 0.14))',
          '--gmn-tooltip-bg': 'rgb(241, 243, 244)',
          '--gmn-tooltip-text': 'rgb(32, 33, 36)',
          '--gmn-tooltip-radius': '18px',
          '--gmn-tooltip-padding': '12px 28px',
          '--gmn-tooltip-min-height': '40px',
          '--gmn-tooltip-font-size': '14px',
          '--gmn-tooltip-line-height': '20px',
          '--gmn-tooltip-font-weight': '400',
          '--gmn-tooltip-arrow-size': '14px',
          '--gmn-tooltip-arrow-radius': '2px',
          '--gmn-menu-width': '242px',
          '--gmn-menu-radius': '20px',
          '--gmn-menu-shadow': 'rgba(0, 0, 0, 0.28) 0px 0px 20px 0px',
          '--gmn-menu-item-min-height': '56px',
          '--gmn-menu-checkbox-item-min-height': '76px',
          '--gmn-menu-item-padding': '8px 16px',
          '--gmn-menu-item-radius': '0',
          '--gmn-menu-font-size': '14px',
          '--gmn-menu-line-height': '20px',
          '--gmn-menu-font-weight': '400',
          '--gmn-menu-leading-slot-size': '20px',
          '--gmn-menu-leading-gap': '12px',
          '--gmn-menu-divider-margin': '0 16px',
          '--gmn-modal-panel-width': 'min(760px, calc(100vw - 24px))',
          '--gmn-modal-panel-height': 'min(680px, calc(100vh - 24px))',
          '--gmn-modal-panel-max-height': 'min(680px, calc(100vh - 24px))',
          '--gmn-modal-panel-radius': '28px',
          '--gmn-modal-panel-padding': '22px',
          '--gmn-modal-panel-gap': '14px',
          '--gmn-modal-font-size': '14px',
          '--gmn-modal-line-height': '1.4',
          '--gmn-modal-title-font-size': '20px',
          '--gmn-modal-title-line-height': '1.2',
          '--gmn-modal-button-height': '40px',
          '--gmn-modal-button-radius': '999px',
          '--gmn-modal-button-font-size': '13px',
          '--gmn-modal-button-font-weight': '500',
          '--gmn-modal-input-height': '40px',
          '--gmn-modal-input-radius': '999px',
          '--gmn-modal-destination-radius': '18px',
          '--gmn-modal-destination-icon-size': '36px',
          '--gmn-modal-destination-icon-glyph-size': '18px',
          '--gmn-modal-list-flex': '1 1 0',
          '--gmn-modal-list-min-height': '0',
          '--gmn-modal-list-gap': '2px',
          '--gmn-modal-list-scrollbar-width': '10px',
          '--gmn-modal-list-row-min-height': '56px',
          '--gmn-modal-list-row-radius': '16px',
          '--gmn-modal-list-row-padding': '10px 14px',
          '--gmn-modal-list-row-gap': '12px',
          '--gmn-modal-checkbox-size': '18px',
      },
  };
  const cloneNativeStyleProfile = (profile) => ({
      name: profile.name,
      version: profile.version,
      source: profile.source,
      cssVars: { ...profile.cssVars },
  });
  const buildGeminiNativeStyleProfile = (_options = {}) => cloneNativeStyleProfile(GEMINI_LR26_NATIVE_STYLE_PROFILE);
  const applyGeminiNativeStyleVars = (element, profile) => {
      element.dataset.gmNativeStyleProfile = profile.name;
      element.dataset.gmNativeStyleVersion = String(profile.version);
      Object.entries(profile.cssVars).forEach(([key, value]) => {
          element.style.setProperty(key, value);
      });
  };

  // ============================================================
  // Inlined from src/browser/shared/modal-virtual-list.ts (auto-generated — do not edit)
  // ============================================================
  const modalFiniteNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
  const computeModalVirtualScrollRange = ({ clientHeight, scrollHeight, itemHeight, virtualItemCount = 0, }) => {
      const measuredHeight = Math.max(0, modalFiniteNumber(scrollHeight));
      const viewportHeight = Math.max(0, modalFiniteNumber(clientHeight));
      const estimatedHeight = Math.max(0, modalFiniteNumber(virtualItemCount)) * Math.max(0, modalFiniteNumber(itemHeight));
      const effectiveHeight = Math.max(measuredHeight, estimatedHeight);
      return Math.max(0, effectiveHeight - viewportHeight);
  };
  const computeModalWheelScroll = ({ scrollTop, deltaY, ctrlKey = false, metaKey = false, ...metrics }) => {
      const currentTop = Math.max(0, modalFiniteNumber(scrollTop));
      const wheelDelta = modalFiniteNumber(deltaY);
      if (!wheelDelta || ctrlKey || metaKey) {
          return { shouldScroll: false, nextScrollTop: currentTop, maxScrollTop: 0 };
      }
      const maxScrollTop = computeModalVirtualScrollRange({
          scrollTop: currentTop,
          ...metrics,
      });
      if (maxScrollTop <= 0) {
          return { shouldScroll: false, nextScrollTop: currentTop, maxScrollTop };
      }
      const nextScrollTop = Math.max(0, Math.min(maxScrollTop, currentTop + wheelDelta));
      return {
          shouldScroll: nextScrollTop !== currentTop,
          nextScrollTop,
          maxScrollTop,
      };
  };

  // ============================================================
  // Inlined from src/core/progress-view-model.ts (auto-generated — do not edit)
  // ============================================================
  const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
  const finiteNumber = (value, fallback = 0) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const normalizeStatus = (status) => {
      if (status === 'idle' ||
          status === 'queued' ||
          status === 'running' ||
          status === 'cancel_requested' ||
          status === 'completed' ||
          status === 'completed_with_errors' ||
          status === 'failed' ||
          status === 'cancelled') {
          return status;
      }
      return 'running';
  };
  const progressTotal = (value) => Math.max(0, finiteNumber(value, 0));
  const safeDeterminateTotal = (value) => Math.max(1, finiteNumber(value, 1));
  const stripLegacyProgressCount = (value) => {
      const text = String(value || '').trim();
      return text
          .replace(/^(Baixando conversa(?:s)?(?: do Gemini| novas)?|Baixando somente o que falta no vault)\s+\(\d+\s*(?:\/|de)\s*\d+\)(?=:)/i, '$1')
          .trim();
  };
  const operationBatchPosition = (job) => {
      const value = job.batchPosition ?? job.current?.batchPosition ?? job.operation?.batchPosition;
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  };
  const operationBatchTotal = (job, fallback = 0) => {
      const value = job.batchTotal ?? job.current?.batchTotal ?? job.operation?.batchTotal ?? fallback;
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  };
  const statusLabelFor = (status, phase) => {
      if (status === 'completed')
          return 'Concluido';
      if (status === 'completed_with_errors')
          return 'Concluido com avisos';
      if (status === 'failed')
          return 'Falhou';
      if (status === 'cancelled')
          return 'Cancelado';
      if (status === 'cancel_requested')
          return 'Cancelando';
      if (phase === 'loading-history')
          return 'Carregando historico';
      if (phase === 'scanning-vault')
          return 'Comparando vault';
      if (phase === 'loading-metadata')
          return 'Indexando datas';
      if (phase === 'resolving-metadata')
          return 'Conferindo datas';
      if (phase === 'exporting')
          return 'Exportando';
      if (phase === 'writing-report')
          return 'Finalizando';
      return 'Preparando';
  };
  const normalizedCounts = (counts) => ({
      downloaded: finiteNumber(counts?.downloaded, 0),
      skipped: finiteNumber(counts?.skipped, 0),
      failed: finiteNumber(counts?.failed, 0),
      warnings: finiteNumber(counts?.warnings, 0),
      webSeen: counts?.webSeen == null ? null : finiteNumber(counts.webSeen, 0),
      existing: counts?.existing == null ? null : finiteNumber(counts.existing, 0),
      missing: counts?.missing == null ? null : finiteNumber(counts.missing, 0),
  });
  const isTerminal = (status) => TERMINAL_STATUSES.has(status);
  const percentFor = ({ status, current, total, mode, }) => {
      if (status === 'completed' || status === 'completed_with_errors')
          return 100;
      if (mode === 'indeterminate' || total <= 0)
          return 0;
      return Math.round(clamp((current / safeDeterminateTotal(total)) * 100, 0, 100));
  };
  const buildProgressViewModel = (input) => {
      const status = normalizeStatus(input.status);
      const phase = input.phase || null;
      const rawTotal = progressTotal(input.total);
      const mode = input.mode || (rawTotal > 0 ? 'determinate' : 'indeterminate');
      const total = mode === 'determinate' ? safeDeterminateTotal(rawTotal) : 0;
      const terminal = isTerminal(status);
      const baseCurrent = status === 'completed' || status === 'completed_with_errors'
          ? total
          : clamp(finiteNumber(input.current ?? input.completed, 0), 0, total || Number.MAX_SAFE_INTEGER);
      const current = mode === 'determinate' ? clamp(baseCurrent, 0, total) : Math.max(0, baseCurrent);
      const displayCurrent = input.displayCurrent == null
          ? current
          : mode === 'determinate'
              ? clamp(finiteNumber(input.displayCurrent, current), 0, total)
              : Math.max(0, finiteNumber(input.displayCurrent, current));
      const barCurrent = input.barCurrent == null
          ? current
          : mode === 'determinate'
              ? clamp(finiteNumber(input.barCurrent, current), 0, total)
              : Math.max(0, finiteNumber(input.barCurrent, current));
      const percent = input.percent == null
          ? percentFor({ status, current, total, mode })
          : clamp(finiteNumber(input.percent, 0), 0, 100);
      const displayPercent = input.displayPercent == null
          ? percent
          : clamp(finiteNumber(input.displayPercent, percent), 0, 100);
      const counts = normalizedCounts(input.counts);
      const countLabel = input.countLabel ||
          (input.sourceKind === 'count' && counts.webSeen != null && counts.webSeen > 0
              ? `${counts.webSeen} encontradas`
              : '');
      return {
          sourceKind: input.sourceKind,
          status,
          phase,
          mode,
          title: input.title || '',
          label: input.label || '',
          statusLabel: input.statusLabel || statusLabelFor(status, phase),
          current,
          total,
          displayCurrent,
          barCurrent,
          percent,
          displayPercent,
          terminal,
          successful: status === 'completed' || status === 'completed_with_errors',
          failed: status === 'failed' || status === 'cancelled',
          countLabel,
          currentItem: input.currentItem || null,
          counts,
          warnings: Array.isArray(input.warnings) ? input.warnings.map(String) : [],
      };
  };
  const jobTotals = (job) => {
      const decision = job.decisionSummary || {};
      const totals = decision.totals || {};
      return normalizedCounts({
          downloaded: totals.downloadedNow ?? job.successCount ?? 0,
          skipped: totals.skipped ?? job.skippedCount ?? 0,
          failed: totals.failed ?? job.failureCount ?? 0,
          warnings: totals.mediaWarnings ?? 0,
          webSeen: totals.geminiWebSeen ?? job.webConversationCount ?? job.loadedCount ?? null,
          existing: totals.existingInVault ?? job.existingVaultCount ?? null,
          missing: totals.missingInVault ?? job.missingCount ?? null,
      });
  };
  const loadedConversationCount = (job, counts) => {
      for (const value of [
          job.knownLoadedCount,
          job.minimumKnownCount,
          job.loadedCount,
          job.webConversationCount,
          counts.webSeen,
      ]) {
          const parsed = Number(value);
          if (Number.isFinite(parsed))
              return parsed;
      }
      return null;
  };
  const indeterminateCountLabel = (job, counts) => {
      const loaded = loadedConversationCount(job, counts);
      if (loaded !== null && loaded > 0)
          return `${loaded} encontradas`;
      if (job.tuiKind === 'count')
          return 'procurando conversas';
      return 'trabalhando';
  };
  const buildExportJobProgressViewModel = (job) => {
      const counts = jobTotals(job);
      const fallbackTotal = finiteNumber(job.requested ?? job.missingCount ?? job.webConversationCount, 0);
      const batchPosition = operationBatchPosition(job);
      const total = operationBatchTotal(job, fallbackTotal);
      const status = normalizeStatus(job.status);
      const phase = typeof job.phase === 'string' ? job.phase : null;
      const terminal = isTerminal(status);
      const successfulTerminal = status === 'completed' || status === 'completed_with_errors';
      const completed = Math.max(0, finiteNumber(job.completed, 0));
      const currentIndex = Math.max(0, finiteNumber(job.current?.index ?? job.position, 0));
      const mode = total > 0 &&
          ![
              'queued',
              'loading-history',
              'scanning-vault',
              'loading-metadata',
              'resolving-metadata',
          ].includes(String(phase || ''))
          ? 'determinate'
          : 'indeterminate';
      const current = total > 0 ? (successfulTerminal ? total : Math.min(completed, total)) : completed;
      const displayCurrent = batchPosition !== null && !successfulTerminal
          ? Math.min(total || batchPosition, batchPosition)
          : total > 0 && !terminal && phase === 'exporting'
              ? Math.min(total, Math.max(completed + 1, currentIndex, 1))
              : current;
      const barCurrent = batchPosition !== null && total > 0 && !terminal
          ? Math.min(total - 0.02, Math.max(0, batchPosition - 0.38))
          : total > 0 && !terminal && phase === 'exporting'
              ? Math.min(total - 0.02, completed + 0.62)
              : current;
      const currentItem = job.current?.title || job.current?.chatId
          ? { title: job.current.title || null, chatId: job.current.chatId || null }
          : null;
      const label = stripLegacyProgressCount(job.operationMessage ||
          job.progressMessage ||
          job.decisionSummary?.headline ||
          'Sincronizando...');
      return buildProgressViewModel({
          sourceKind: job.sourceKind || 'export-job',
          status,
          phase,
          mode,
          title: 'Gemini Markdown Export',
          label,
          current,
          total,
          displayCurrent,
          barCurrent,
          countLabel: total > 0
              ? batchPosition !== null
                  ? `${Math.min(displayCurrent, total)} de ${total}`
                  : `${Math.min(displayCurrent, total)}/${total}`
              : indeterminateCountLabel(job, counts),
          currentItem,
          counts,
      });
  };
  const buildGuiExportProgressViewModel = (progress) => buildProgressViewModel({
      sourceKind: 'gui-export',
      status: progress.status || 'running',
      phase: progress.phase || null,
      title: progress.title || 'Baixando conversas',
      label: progress.label || 'Baixando conversas...',
      current: progress.current ?? progress.completed ?? 0,
      completed: progress.completed,
      total: progress.total ?? 1,
      position: progress.position,
      displayPercent: progress.displayPercent,
      currentItem: progress.title || progress.chatId || progress.currentChatId
          ? {
              title: progress.title || null,
              chatId: progress.currentChatId || progress.chatId || null,
          }
          : null,
      counts: { failed: progress.errorCount ?? 0 },
  });
  const buildActivityProgressViewModel = (progress) => {
      const candidateTotal = Math.max(0, finiteNumber(progress.candidateTotal, 0));
      const resolved = Math.max(0, finiteNumber(progress.resolvedCount, 0));
      const scanned = Math.max(0, finiteNumber(progress.scannedCardCount, 0));
      const loaded = Math.max(scanned, finiteNumber(progress.loadedCardCount, 0));
      const maxCards = Math.max(1, finiteNumber(progress.maxCards || loaded || 1, 1));
      const rawStatus = normalizeStatus(progress.status || 'running');
      const pending = Math.max(0, candidateTotal - Math.min(resolved, candidateTotal));
      const status = rawStatus === 'completed' && pending > 0 ? 'failed' : rawStatus;
      let label = `${scanned} itens lidos`;
      if (status === 'completed')
          label = 'Todas as datas encontradas';
      else if (rawStatus === 'completed' && pending > 0)
          label = `${pending} pendente(s)`;
      else if (status === 'failed')
          label = rawStatus === 'completed' && pending > 0 ? `${pending} pendente(s)` : 'Falhou';
      else if (loaded > scanned)
          label = `${scanned} itens lidos · ${loaded} carregados`;
      const total = candidateTotal > 0 ? candidateTotal : maxCards;
      const current = candidateTotal > 0 ? Math.min(resolved, candidateTotal) : scanned;
      return buildProgressViewModel({
          sourceKind: 'activity-scan',
          status,
          phase: 'activity-scan',
          title: 'Identificando chats',
          label,
          current,
          total,
          countLabel: candidateTotal > 0 ? `${Math.min(resolved, candidateTotal)} de ${candidateTotal}` : '',
      });
  };
  const buildFixVaultProgressViewModel = ({ current, total, message, }) => buildProgressViewModel({
      sourceKind: 'fix-vault',
      status: 'running',
      phase: 'fix-vault',
      title: 'Fix vault',
      label: message,
      current,
      total,
      countLabel: `${current}/${total}`,
  });
  const ordinalFor = (view) => Math.max(view.displayCurrent, view.current, view.barCurrent);
  const mergeProgressViewModel = (previous, next) => {
      if (!previous)
          return next;
      if (next.terminal)
          return next;
      if (previous.sourceKind !== next.sourceKind)
          return next;
      if (previous.total > next.total) {
          return {
              ...next,
              total: previous.total,
              current: Math.max(previous.current, next.current),
              displayCurrent: Math.max(previous.displayCurrent, next.displayCurrent),
              barCurrent: Math.max(previous.barCurrent, next.barCurrent),
              label: previous.label || next.label,
              currentItem: previous.currentItem || next.currentItem,
          };
      }
      if (ordinalFor(next) < ordinalFor(previous))
          return previous;
      return next;
  };
  const shouldRunProgressCreep = (view) => {
      if (view.terminal || view.failed)
          return false;
      if (view.mode === 'indeterminate')
          return false;
      if (view.current >= view.total)
          return false;
      if (view.total > 1)
          return true;
      const phase = String(view.phase || '').toLowerCase();
      return (view.displayCurrent > 0 ||
          phase.includes('export') ||
          phase.includes('hidrata') ||
          phase.includes('navega') ||
          phase.includes('writing') ||
          phase.includes('escrit') ||
          phase.includes('salv'));
  };
  const progressCreepCeiling = (view) => {
      if (!shouldRunProgressCreep(view))
          return view.percent;
      const next = Math.min(100, (Math.min(view.current + 1, view.total) / safeDeterminateTotal(view.total)) * 100);
      return view.percent + (next - view.percent) * 0.85;
  };
  const normalizeProgressDisplayPercent = (previous, next, previousDisplayPercent = previous?.displayPercent ?? 0) => {
      if (next.status === 'completed' || next.status === 'completed_with_errors')
          return 100;
      const previousTotal = previous?.total ?? 1;
      const previousCurrent = previous?.current ?? 0;
      const previousDisplay = finiteNumber(previousDisplayPercent, 0);
      const ceiling = progressCreepCeiling(next);
      const totalChanged = previousTotal !== next.total;
      const placeholderExpanded = previousTotal <= 1 && next.total > previousTotal;
      const realProgressRegressed = next.current < previousCurrent;
      const displayPastNewMilestone = previousDisplay > next.percent + 3;
      if (placeholderExpanded ||
          realProgressRegressed ||
          (totalChanged && next.current === 0 && displayPastNewMilestone) ||
          (totalChanged && displayPastNewMilestone)) {
          return next.percent;
      }
      return Math.min(Math.max(previousDisplay, next.percent), ceiling);
  };

  // ============================================================
  // Inlined from src/browser/shared/progress-state.ts (auto-generated — do not edit)
  // ============================================================

  const SHARED_PROGRESS_CREEP_MAX_FRACTION = 0.85;
  const sharedProgressBarCurrent = (progress) => {
      const view = buildProgressViewModel({
          sourceKind: 'gui-export',
          status: progress?.status || 'running',
          phase: progress?.phase || null,
          current: progress?.current ?? progress?.completed ?? 0,
          completed: progress?.completed ?? null,
          total: progress?.total ?? 1,
          position: progress?.position ?? null,
      });
      return view.current;
  };
  const sharedComputeProgressMilestone = (progress) => {
      const view = buildProgressViewModel({
          sourceKind: 'gui-export',
          status: progress?.status || 'running',
          phase: progress?.phase || null,
          current: progress?.current ?? progress?.completed ?? 0,
          completed: progress?.completed ?? null,
          total: progress?.total ?? 1,
          position: progress?.position ?? null,
      });
      return {
          base: view.percent,
          next: Math.min(100, (Math.min(view.current + 1, view.total) / Math.max(1, view.total)) * 100),
      };
  };
  const sharedProgressCreepCeiling = (progress) => {
      const view = buildProgressViewModel({
          sourceKind: 'gui-export',
          status: progress?.status || 'running',
          phase: progress?.phase || null,
          current: progress?.current ?? progress?.completed ?? 0,
          completed: progress?.completed ?? null,
          total: progress?.total ?? 1,
          position: progress?.position ?? null,
      });
      return progressCreepCeiling(view);
  };
  const sharedShouldRunProgressCreep = (progress) => sharedProgressCreepCeiling(progress) > sharedComputeProgressMilestone(progress).base;
  const sharedNormalizeProgressDisplayPercent = ({ previousProgress = null, nextProgress, previousDisplayPercent = 0, }) => {
      const previous = previousProgress
          ? buildProgressViewModel({
              sourceKind: 'gui-export',
              status: previousProgress.status || 'running',
              phase: previousProgress.phase || null,
              current: previousProgress.current ?? previousProgress.completed ?? 0,
              completed: previousProgress.completed ?? null,
              total: previousProgress.total ?? 1,
              position: previousProgress.position ?? null,
              displayPercent: previousDisplayPercent,
          })
          : null;
      const next = buildProgressViewModel({
          sourceKind: 'gui-export',
          status: nextProgress.status || 'running',
          phase: nextProgress.phase || null,
          current: nextProgress.current ?? nextProgress.completed ?? 0,
          completed: nextProgress.completed ?? null,
          total: nextProgress.total ?? 1,
          position: nextProgress.position ?? null,
      });
      return normalizeProgressDisplayPercent(previous, next, previousDisplayPercent ?? 0);
  };

  // ============================================================
  // Inlined from src/browser/shared/progress-dock-ui.ts (auto-generated — do not edit)
  // ============================================================

  const SHARED_PROGRESS_DOCK_ID = 'gm-md-export-progress-dock';
  const ensureSharedProgressDock = ({ dockId = SHARED_PROGRESS_DOCK_ID, initialTitle = '', documentRef = document, } = {}) => {
      let dock = documentRef.getElementById(dockId);
      if (dock)
          return dock;
      dock = documentRef.createElement('div');
      dock.id = dockId;
      dock.setAttribute('data-gm-shared-progress-dock', 'true');
      dock.hidden = true;
      Object.assign(dock.style, {
          position: 'fixed',
          left: '50%',
          bottom: '18px',
          transform: 'translateX(-50%)',
          zIndex: '10002',
          display: 'none',
          pointerEvents: 'none',
          width: 'min(360px, calc(100vw - 24px))',
      });
      dock.innerHTML = `
      <style>
        #${dockId} .gm-dock-card {
          font-family: var(--gm-font);
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 14px 16px;
          border-radius: 22px;
          background: var(--gm-dock-bg);
          color: var(--gm-dock-text);
          border: 1px solid var(--gm-dock-border);
          box-shadow:
            0 16px 40px rgba(0,0,0,0.40),
            0 2px 8px rgba(0,0,0,0.24);
          backdrop-filter: blur(14px);
        }
        #${dockId} .gm-dock-track {
          height: 6px;
          background: var(--gm-dock-track);
          border-radius: 999px;
          overflow: hidden;
          position: relative;
        }
        #${dockId} .gm-dock-bar {
          height: 100%;
          width: 0%;
          background: var(--gm-accent);
          border-radius: 999px;
          position: relative;
          overflow: hidden;
          transition: width 420ms cubic-bezier(0.22, 0.61, 0.36, 1);
          will-change: width;
        }
        #${dockId} .gm-dock-bar::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(
            90deg,
            rgba(255,255,255,0) 0%,
            rgba(255,255,255,0.55) 50%,
            rgba(255,255,255,0) 100%
          );
          transform: translateX(-100%);
          animation: gm-dock-shimmer 1500ms linear infinite;
        }
        #${dockId}.gm-dock-done .gm-dock-bar {
          background: var(--gm-dock-done-bg, var(--gm-accent));
        }
        #${dockId}.gm-dock-done .gm-dock-bar::after {
          animation: none;
          opacity: 0;
        }
        @keyframes gm-dock-shimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      </style>
      <div class="gm-dock-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <strong id="${dockId}-title" style="font-size:12px;font-weight:600;letter-spacing:0.01em;"></strong>
          <span id="${dockId}-count" style="font-size:11px;color:var(--gm-dock-muted);white-space:nowrap;"></span>
        </div>
        <div id="${dockId}-label" style="font-size:12px;color:var(--gm-dock-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
        <div class="gm-dock-track">
          <div id="${dockId}-bar" class="gm-dock-bar"></div>
        </div>
      </div>
    `;
      documentRef.body.appendChild(dock);
      const titleEl = documentRef.getElementById(`${dockId}-title`);
      if (titleEl)
          titleEl.textContent = initialTitle;
      return dock;
  };
  const applySharedProgressDockTheme = (dock, { dark = false, documentRef = document } = {}) => {
      if (!dock)
          return;
      applyCssVars(dock, buildDockHostPalette({ documentRef, isDark: dark }));
  };
  const getSharedProgressDockElements = ({ dockId = SHARED_PROGRESS_DOCK_ID, documentRef = document, } = {}) => ({
      titleEl: documentRef.getElementById(`${dockId}-title`),
      countEl: documentRef.getElementById(`${dockId}-count`),
      labelEl: documentRef.getElementById(`${dockId}-label`),
      barEl: documentRef.getElementById(`${dockId}-bar`),
  });
  const setSharedProgressDockVisible = (dock, visible) => {
      if (!dock)
          return;
      dock.hidden = !visible;
      dock.style.display = visible ? 'block' : 'none';
  };

      // ============================================================
  // Inlined from src/browser/shared/progress-port.ts (auto-generated — do not edit)
  // ============================================================
  const clampPercent = (current, total, status) => {
      if (status === 'completed' || status === 'completed_with_errors')
          return 100;
      const safeTotal = Math.max(1, Number(total) || 1);
      return Math.max(0, Math.min(100, Math.round((Math.max(0, Number(current) || 0) / safeTotal) * 100)));
  };
  const isDoneStatus = (status) => status === 'completed' || status === 'completed_with_errors';
  const createSharedProgressPort = (options) => {
      let current = null;
      const render = () => {
          const dock = options.ensureDock({
              dockId: options.dockId,
              initialTitle: options.initialTitle || '',
              documentRef: options.documentRef,
          });
          if (!current) {
              options.setVisible(dock, false);
              dock.classList.remove('gm-dock-done');
              return;
          }
          options.applyTheme(dock, { dark: options.isDarkTheme?.() === true });
          const { titleEl, countEl, labelEl, barEl } = options.getElements({
              dockId: options.dockId,
              documentRef: options.documentRef,
          });
          const safeTotal = Math.max(1, Number(current.total) || 1);
          const safeCurrent = Math.max(0, Number(current.current) || 0);
          if (titleEl)
              titleEl.textContent = current.title;
          if (countEl)
              countEl.textContent =
                  current.total > 0 ? `${Math.min(safeCurrent, safeTotal)} de ${safeTotal}` : '';
          if (labelEl)
              labelEl.textContent = current.label;
          if (barEl)
              barEl.style.width = `${clampPercent(safeCurrent, safeTotal, current.status)}%`;
          if (isDoneStatus(current.status))
              dock.classList.add('gm-dock-done');
          else
              dock.classList.remove('gm-dock-done');
          options.setVisible(dock, true);
      };
      return {
          begin(snapshot) {
              current = { ...snapshot };
              render();
          },
          update(patch) {
              current = {
                  title: patch.title || current?.title || options.initialTitle || '',
                  label: patch.label || current?.label || '',
                  current: patch.current ?? current?.current ?? 0,
                  total: patch.total ?? current?.total ?? 1,
                  status: patch.status || current?.status || 'running',
              };
              render();
          },
          finish(patch = {}) {
              const total = patch.total ?? current?.total ?? 1;
              current = {
                  title: patch.title || current?.title || options.initialTitle || '',
                  label: patch.label || current?.label || 'Concluido',
                  current: patch.current ?? total,
                  total,
                  status: patch.status || current?.status || 'completed',
              };
              render();
          },
          hide() {
              current = null;
              render();
          },
          snapshot() {
              return current ? { ...current } : null;
          },
      };
  };

      // ============================================================
  // Inlined from src/browser/shared/tab-commands.ts (auto-generated — do not edit)
  // ============================================================
  const numberOrNull = (value) => {
      const number = Number(value);
      return Number.isInteger(number) ? number : null;
  };
  const commandArgs = (command) => command.args || {};
  const sharedTabCommandSideEffectCommands = new Set([
      'activate-browser-tab',
      'activate-tab',
      'claim-tab',
      'release-tab-claim',
      'release-tab-claim-by-tab-id',
      'reload-extension-self',
  ]);
  const hasExplicitBrowserIntent = (args) => args.explicit === true ||
      args.explicitBrowserSideEffect === true ||
      args.browserSideEffectExplicit === true;
  const hasBrowserAuthorityLease = (args) => typeof args.browserAuthorityLeaseId === 'string' &&
      args.browserAuthorityLeaseId.trim().length > 0;
  const sharedTabCommandExplicitIntentRequired = (command) => ({
      ok: false,
      code: 'explicit_browser_intent_required',
      status: 'explicit-browser-intent-required',
      reason: command.args?.reason || 'bridge-command',
      skipped: true,
  });
  const sharedTabCommandAuthorityLeaseRequired = (command) => ({
      ok: false,
      code: 'browser_authority_lease_missing',
      status: 'browser-authority-lease-missing',
      reason: command.args?.reason || 'bridge-command',
      skipped: true,
  });
  const createSharedTabCommandHandlers = (options) => {
      const getTabId = () => options.getTabId?.() ?? options.state?.tabId ?? null;
      const getWindowId = () => options.getWindowId?.() ?? options.state?.windowId ?? null;
      const getTabClaim = () => options.getTabClaim?.() ?? options.state?.tabClaim ?? null;
      const setTabClaim = (claim) => {
          if (options.setTabClaim)
              options.setTabClaim(claim);
          else if (options.state)
              options.state.tabClaim = claim;
      };
      const clearTabClaim = () => {
          if (options.clearTabClaim)
              options.clearTabClaim();
          else
              setTabClaim(null);
      };
      const execute = async (command) => {
          const args = commandArgs(command);
          if (command.type === 'get-extension-info') {
              if (options.getExtensionInfo)
                  return options.getExtensionInfo(command);
              const response = await options.extensionSendMessage({ type: 'GET_EXTENSION_INFO' }, { timeoutMs: 3500 });
              if (response?.ok && options.state) {
                  options.state.extensionVersion =
                      String(response.extensionVersion || response.version || '') || null;
                  options.state.protocolVersion =
                      typeof response.protocolVersion === 'number' ? response.protocolVersion : null;
                  options.state.buildStamp = String(response.buildStamp || '') || null;
                  options.state.tabId = numberOrNull(response.tabId);
                  options.state.windowId = numberOrNull(response.windowId);
                  options.state.isActiveTab =
                      typeof response.isActiveTab === 'boolean' ? response.isActiveTab : null;
              }
              return {
                  ...(response || { ok: false, reason: 'empty-extension-info-response' }),
                  contentScript: true,
                  serviceWorker: response?.ok === true,
              };
          }
          if (sharedTabCommandSideEffectCommands.has(String(command.type || '')) &&
              !hasExplicitBrowserIntent(args)) {
              return sharedTabCommandExplicitIntentRequired(command);
          }
          if (sharedTabCommandSideEffectCommands.has(String(command.type || '')) &&
              !hasBrowserAuthorityLease(args)) {
              return sharedTabCommandAuthorityLeaseRequired(command);
          }
          if (command.type === 'reload-extension-self') {
              const response = await options.extensionSendMessage({
                  type: 'RELOAD_SELF',
                  reason: args.reason || options.defaultReason,
                  expectedExtensionVersion: args.expectedExtensionVersion || null,
                  expectedProtocolVersion: args.expectedProtocolVersion || null,
                  expectedBuildStamp: args.expectedBuildStamp || null,
              }, { timeoutMs: 3500 });
              return response || { ok: false, reason: 'empty-reload-response' };
          }
          if (command.type === 'activate-tab' || command.type === 'activate-browser-tab') {
              const requestedTabId = numberOrNull(args.tabId ?? args.targetTabId);
              const response = await options.extensionSendMessage({
                  type: 'gemini-md-export/activate-tab',
                  tabId: requestedTabId ?? undefined,
                  reason: args.reason || options.defaultReason,
                  focusWindow: args.focusWindow === true,
              }, { timeoutMs: 5000 });
              const localTabId = numberOrNull(getTabId());
              if (typeof response?.isActiveTab === 'boolean' &&
                  (requestedTabId === null || requestedTabId === localTabId)) {
                  if (options.setIsActiveTab)
                      options.setIsActiveTab(response.isActiveTab);
                  else if (options.state)
                      options.state.isActiveTab = response.isActiveTab;
              }
              return response || { ok: false, reason: 'empty-activate-tab-response' };
          }
          if (command.type === 'claim-tab') {
              const claimId = String(args.claimId || '').trim();
              if (!claimId)
                  return { ok: false, reason: 'claim-id-required' };
              const claim = {
                  claimId,
                  sessionId: args.sessionId || null,
                  label: args.label || options.defaultClaimLabel,
                  color: args.color || options.defaultClaimColor,
                  expiresAt: args.expiresAt || null,
                  visualGroupTabId: numberOrNull(args.visualGroupTabId ?? args.groupWithTabId),
              };
              const response = await options.extensionSendMessage({
                  type: 'gemini-md-export/claim-tab',
                  ...claim,
              }, { timeoutMs: 5000 });
              if (response?.ok) {
                  if (options.rememberTabClaim)
                      options.rememberTabClaim(claim, response);
                  else {
                      setTabClaim({
                          ...claim,
                          tabId: response.tabId ??
                              response.visual?.tabId ??
                              getTabId(),
                          windowId: response.windowId ?? getWindowId(),
                          visual: response.visual || response,
                      });
                  }
              }
              return response || { ok: false, reason: 'empty-claim-response' };
          }
          if (command.type === 'release-tab-claim') {
              if (options.releaseCurrentTabClaim) {
                  const response = await options.releaseCurrentTabClaim({
                      claimId: args.claimId || null,
                      reason: String(args.reason || options.defaultReason),
                  });
                  return response || { ok: false, reason: 'empty-release-response' };
              }
              const response = await options.extensionSendMessage({
                  type: 'gemini-md-export/release-tab-claim',
                  tabId: args.tabId ?? getTabId(),
                  claimId: args.claimId || getTabClaim()?.claimId || null,
                  reason: args.reason || options.defaultReason,
              }, { timeoutMs: 5000 });
              if (response?.ok)
                  clearTabClaim();
              return response || { ok: false, reason: 'empty-release-response' };
          }
          if (command.type === 'release-tab-claim-by-tab-id') {
              const requestedTabId = numberOrNull(args.tabId);
              const response = await options.extensionSendMessage({
                  type: 'gemini-md-export/release-tab-claim',
                  tabId: requestedTabId ?? getTabId(),
                  claimId: args.claimId || getTabClaim()?.claimId || null,
                  reason: args.reason || `${options.defaultReason}-tab-id-release`,
              }, { timeoutMs: 5000 });
              const localTabId = numberOrNull(getTabId());
              const localClaim = getTabClaim();
              const targetsThisTab = requestedTabId !== null && localTabId !== null && requestedTabId === localTabId;
              const claimMatches = !args.claimId || !localClaim?.claimId || localClaim.claimId === args.claimId;
              if (response?.ok && targetsThisTab && claimMatches)
                  clearTabClaim();
              await options.afterReleaseByTabId?.({
                  command,
                  response,
                  requestedTabId: requestedTabId ?? -1,
              });
              return response || { ok: false, reason: 'empty-release-response' };
          }
          return undefined;
      };
      return { execute };
  };

      // ============================================================
  // Inlined from src/browser/shared/bridge-client.ts (auto-generated — do not edit)
  // ============================================================
  const RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY = 'gemini-md-export.pendingBridgeCommand.v1';
  const RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS = 5 * 60_000;
  const RESUMABLE_BRIDGE_COMMAND_TYPES = new Set(['get-chat-by-id']);
  const DEFAULT_HEARTBEAT_INTERVAL_MS = 3000;
  const DEFAULT_POLL_TIMEOUT_MS = 30000;
  const COMMAND_CACHE_TTL_MS = 5 * 60_000;
  const defaultRandomId = () => {
      try {
          return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
      }
      catch {
          return Math.random().toString(36).slice(2);
      }
  };
  const getOrCreateBridgeClientId = ({ storage, storageKey, prefix, randomId = defaultRandomId, }) => {
      try {
          const existing = storage?.getItem(storageKey);
          if (existing)
              return existing;
          const created = `${prefix}-${randomId()}`;
          storage?.setItem(storageKey, created);
          return created;
      }
      catch {
          return `${prefix}-${randomId()}`;
      }
  };
  const isResumableBridgeCommand = (command) => !!command?.id && RESUMABLE_BRIDGE_COMMAND_TYPES.has(String(command.type || ''));
  const savePendingBridgeCommand = (storage, command, { now = Date.now() } = {}) => {
      if (!storage || !isResumableBridgeCommand(command))
          return false;
      storage.setItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY, JSON.stringify({
          version: 1,
          savedAt: now,
          command,
      }));
      return true;
  };
  const clearPendingBridgeCommand = (storage, commandId) => {
      if (!storage)
          return false;
      if (commandId) {
          const pending = readPendingBridgeCommand(storage);
          if (pending?.id && pending.id !== commandId)
              return false;
      }
      storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
      return true;
  };
  const readPendingBridgeCommand = (storage, { now = Date.now(), maxAgeMs = RESUMABLE_BRIDGE_COMMAND_MAX_AGE_MS, } = {}) => {
      if (!storage)
          return null;
      let parsed = null;
      try {
          const raw = storage.getItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
          parsed = raw ? JSON.parse(raw) : null;
      }
      catch {
          storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
          return null;
      }
      const command = parsed?.command || null;
      const savedAt = Number(parsed?.savedAt || 0);
      if (parsed?.version !== 1 ||
          !isResumableBridgeCommand(command) ||
          !Number.isFinite(savedAt) ||
          now - savedAt > maxAgeMs) {
          storage.removeItem(RESUMABLE_BRIDGE_COMMAND_STORAGE_KEY);
          return null;
      }
      return command;
  };
  const defaultBridgeRequest = (bridgeBaseUrl) => async (path, options = {}) => {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? 10000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
          const response = await fetch(`${bridgeBaseUrl}${path}`, {
              method: options.method || 'GET',
              headers: options.payload ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
              body: options.payload ? JSON.stringify(options.payload) : undefined,
              mode: 'cors',
              cache: 'no-store',
              signal: controller.signal,
          });
          if (response.status === 204)
              return null;
          const text = await response.text();
          if (!response.ok)
              throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
          return text ? JSON.parse(text) : null;
      }
      finally {
          clearTimeout(timer);
      }
  };
  const defaultEventSourceFactory = (url) => new EventSource(url);
  const parseEventPayload = (event) => {
      try {
          return event.data ? JSON.parse(event.data) : {};
      }
      catch {
          return null;
      }
  };
  const createBrowserBridgeClient = (options) => {
      const bridgeRequest = options.bridgeRequest || defaultBridgeRequest(options.bridgeBaseUrl);
      const eventSourceFactory = options.eventSourceFactory || defaultEventSourceFactory;
      const setIntervalRef = options.setIntervalRef || setInterval;
      const clearIntervalRef = options.clearIntervalRef || clearInterval;
      const heartbeatIntervalMs = options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
      const heartbeatTimeoutMs = options.heartbeatTimeoutMs || 10000;
      const pollTimeoutMs = options.pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS;
      const state = {
          kind: options.kind,
          clientId: options.clientId,
          started: false,
          heartbeatInFlight: false,
          heartbeatTimer: 0,
          polling: false,
          eventsConnected: false,
          eventSource: null,
          commandResultCache: new Map(),
          tabId: null,
          windowId: null,
          isActiveTab: null,
          tabClaim: null,
          lastError: null,
      };
      const rememberCommandResult = (commandId, result) => {
          const now = Date.now();
          const existing = state.commandResultCache.get(commandId);
          state.commandResultCache.set(commandId, {
              result,
              at: now,
              deliveredAt: existing?.deliveredAt || 0,
              attempts: existing?.attempts || 0,
              lastAttemptAt: existing?.lastAttemptAt || 0,
              lastError: existing?.lastError || null,
          });
          for (const [key, cached] of state.commandResultCache.entries()) {
              if (now - cached.at > COMMAND_CACHE_TTL_MS)
                  state.commandResultCache.delete(key);
          }
      };
      const postCommandResult = async (command, result) => {
          if (options.postCommandResult)
              return options.postCommandResult(command, result);
          return bridgeRequest('/bridge/command-result', {
              method: 'POST',
              payload: {
                  clientId: state.clientId,
                  commandId: command.id,
                  result: result,
              },
              timeoutMs: 10000,
          });
      };
      const closeEventSource = () => {
          if (state.eventSource) {
              try {
                  state.eventSource.close();
              }
              catch {
                  // ignore stale event source
              }
              state.eventSource = null;
          }
          state.eventsConnected = false;
      };
      const deliverCommandResult = async (command, cached) => {
          const now = Date.now();
          cached.at = now;
          cached.attempts = (cached.attempts || 0) + 1;
          cached.lastAttemptAt = now;
          try {
              await postCommandResult(command, cached.result);
              cached.deliveredAt = Date.now();
              cached.lastError = null;
              state.lastError = null;
              return true;
          }
          catch (err) {
              cached.deliveredAt = 0;
              cached.lastError = err instanceof Error ? err.message : String(err);
              state.lastError = cached.lastError;
              options.onError?.(err);
              return false;
          }
      };
      const flushPendingCommandResults = async () => {
          for (const [commandId, cached] of state.commandResultCache.entries()) {
              if (cached.deliveredAt)
                  continue;
              await deliverCommandResult({ id: commandId }, cached);
          }
      };
      const handleCommand = async (command) => {
          if (!command?.id)
              return;
          options.onCommandReceived?.(command);
          const cached = state.commandResultCache.get(command.id);
          if (cached) {
              await deliverCommandResult(command, cached);
              return;
          }
          let result;
          try {
              result = await options.executeCommand(command);
          }
          catch (err) {
              result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          rememberCommandResult(command.id, result);
          const stored = state.commandResultCache.get(command.id);
          if (stored)
              await deliverCommandResult(command, stored);
      };
      const sendHeartbeat = async () => {
          if (!state.started || state.heartbeatInFlight)
              return;
          state.heartbeatInFlight = true;
          try {
              await options.beforeHeartbeat?.();
              const payload = (await options.buildHeartbeatPayload?.()) || {
                  clientId: state.clientId,
                  kind: options.kind,
                  capabilities: options.capabilities,
                  page: options.getPageSnapshot(),
              };
              const response = await bridgeRequest('/bridge/heartbeat', {
                  method: 'POST',
                  payload,
                  timeoutMs: heartbeatTimeoutMs,
              });
              state.lastError = null;
              if (response?.clientId && typeof response.clientId === 'string')
                  state.clientId = response.clientId;
              if (response?.jobProgress && typeof response.jobProgress === 'object') {
                  options.onJobProgress?.(response.jobProgress);
              }
              else {
                  options.onJobProgress?.(null);
              }
              await options.onHeartbeatResponse?.(response);
              await flushPendingCommandResults();
              if (response?.command && typeof response.command === 'object') {
                  await handleCommand(response.command);
              }
              if (response?.commandPollRequired) {
                  void pollCommands(true, { force: true });
              }
              return response;
          }
          catch (err) {
              state.lastError = err instanceof Error ? err.message : String(err);
              options.onError?.(err);
              return undefined;
          }
          finally {
              state.heartbeatInFlight = false;
          }
      };
      const pollCommands = async (enabled = true, { force = false } = {}) => {
          if (!enabled || !state.started || state.polling || (state.eventsConnected && !force))
              return;
          state.polling = true;
          try {
              const response = await bridgeRequest(`/bridge/command?clientId=${encodeURIComponent(state.clientId)}`, { timeoutMs: pollTimeoutMs });
              if (response?.command && typeof response.command === 'object') {
                  await handleCommand(response.command);
              }
          }
          catch (err) {
              state.lastError = err instanceof Error ? err.message : String(err);
              options.onError?.(err);
          }
          finally {
              state.polling = false;
          }
      };
      const connectEvents = () => {
          if (!state.started || state.eventsConnected || state.eventSource)
              return;
          const url = `${options.bridgeBaseUrl}/bridge/events?clientId=${encodeURIComponent(state.clientId)}`;
          let events;
          try {
              events = eventSourceFactory(url);
          }
          catch (err) {
              state.eventSource = null;
              state.eventsConnected = false;
              state.lastError = err instanceof Error ? err.message : String(err);
              options.onError?.(err);
              return;
          }
          state.eventSource = events;
          events.addEventListener('open', () => {
              state.eventsConnected = true;
              state.lastError = null;
          });
          events.addEventListener('command', (event) => {
              const payload = parseEventPayload(event);
              if (payload?.command && typeof payload.command === 'object') {
                  handleCommand(payload.command).catch((err) => {
                      state.lastError = err instanceof Error ? err.message : String(err);
                      options.onError?.(err);
                  });
              }
          });
          events.addEventListener('jobProgress', (event) => {
              options.onJobProgress?.(parseEventPayload(event));
          });
          events.addEventListener('error', () => {
              if (state.eventSource === events)
                  closeEventSource();
          });
      };
      const stop = () => {
          state.started = false;
          state.heartbeatInFlight = false;
          if (state.heartbeatTimer) {
              clearIntervalRef(state.heartbeatTimer);
              state.heartbeatTimer = 0;
          }
          closeEventSource();
          state.polling = false;
      };
      const start = async ({ connectEvents: shouldConnectEvents = true, startHeartbeatTimer = true, } = {}) => {
          if (state.started)
              return;
          state.started = true;
          if (shouldConnectEvents)
              connectEvents();
          if (startHeartbeatTimer) {
              state.heartbeatTimer = setIntervalRef(sendHeartbeat, heartbeatIntervalMs);
              state.heartbeatTimer?.unref?.();
          }
      };
      return {
          start,
          stop,
          sendHeartbeat,
          pollCommands,
          handleCommand,
          connectEvents,
          state,
      };
  };

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const BRIDGE_BASE_URL = pageWindow.__GEMINI_MCP_BRIDGE_URL || 'http://127.0.0.1:47283';
    const CLIENT_ID_STORAGE_KEY = 'gemini-md-export.activityClientId.v1';
    const HEARTBEAT_INTERVAL_MS = 3000;
    const COMMAND_POLL_TIMEOUT_MS = 30000;
    const CONTENT_SCRIPT_PING_TYPE = 'gemini-md-export/content-ping';
    const SCROLL_SETTLE_MS = 500;
    const DEFAULT_MAX_CARDS = 1000;
    const DEFAULT_MAX_SCROLL_ROUNDS = 80;
    const DATE_CONTEXT_PREVIOUS_SIBLING_LIMIT = 80;
    const MATCH_THRESHOLD = 0.58;
    const PROGRESS_DOCK_ID = 'gm-md-export-progress-dock';
    const TAB_CLAIM_DEFAULT_LABEL = '🔎 Conferindo';
    const state = {
        started: false,
        clientId: '',
        heartbeatTimer: 0,
        heartbeatInFlight: false,
        eventSource: null,
        commandResultCache: new Map(),
        extensionInfoLoadedAt: 0,
        extensionVersion: null,
        protocolVersion: null,
        buildStamp: null,
        tabId: null,
        windowId: null,
        isActiveTab: null,
        tabClaim: null,
        activityProgress: null,
        activityProgressHideTimer: 0,
        mcpProgress: null,
        mcpProgressHideTimer: 0,
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const portableIsoSeconds = (value) => {
        if (!value)
            return null;
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime()))
            return null;
        return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    };
    const getOrCreateActivityClientId = () => getOrCreateBridgeClientId({
        storage: pageWindow.sessionStorage,
        storageKey: CLIENT_ID_STORAGE_KEY,
        prefix: 'activity',
    });
    const bridgeRequest = async (path, { method = 'GET', payload, timeoutMs = 10000 } = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${BRIDGE_BASE_URL}${path}`, {
                method,
                headers: payload ? { 'content-type': 'text/plain;charset=UTF-8' } : undefined,
                body: payload ? JSON.stringify(payload) : undefined,
                mode: 'cors',
                cache: 'no-store',
                signal: controller.signal,
            });
            if (response.status === 204)
                return null;
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`bridge ${response.status}: ${text || response.statusText}`);
            }
            return text ? JSON.parse(text) : null;
        }
        finally {
            clearTimeout(timer);
        }
    };
    const extensionSendMessage = (message, { timeoutMs = 5000 } = {}) => new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
            resolve({ ok: false, reason: 'runtime-message-unavailable' });
            return;
        }
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            finish({ ok: false, reason: 'runtime-message-timeout' });
        }, timeoutMs);
        try {
            chrome.runtime.sendMessage(message, (response) => {
                const lastError = chrome.runtime.lastError;
                if (lastError) {
                    finish({ ok: false, reason: lastError.message || String(lastError) });
                    return;
                }
                finish(response || { ok: false, reason: 'empty-runtime-response' });
            });
        }
        catch (err) {
            finish({ ok: false, reason: err?.message || String(err) });
        }
    });
    const refreshExtensionInfo = async ({ force = false } = {}) => {
        const now = Date.now();
        if (!force && state.extensionInfoLoadedAt && now - state.extensionInfoLoadedAt < 30_000) {
            return {
                ok: true,
                extensionVersion: state.extensionVersion,
                protocolVersion: state.protocolVersion,
                buildStamp: state.buildStamp,
                tabId: state.tabId,
                windowId: state.windowId,
                isActiveTab: state.isActiveTab,
            };
        }
        const response = await extensionSendMessage({ type: 'GET_EXTENSION_INFO' }, { timeoutMs: 3500 });
        if (response?.ok) {
            state.extensionVersion = response.extensionVersion || response.version || null;
            state.protocolVersion = response.protocolVersion ?? null;
            state.buildStamp = response.buildStamp || null;
            state.tabId = response.tabId ?? null;
            state.windowId = response.windowId ?? null;
            state.isActiveTab = response.isActiveTab ?? null;
            state.extensionInfoLoadedAt = now;
        }
        return response;
    };
    const sharedTabCommands = createSharedTabCommandHandlers({
        state,
        defaultReason: 'activity-bridge-command',
        defaultClaimLabel: TAB_CLAIM_DEFAULT_LABEL,
        defaultClaimColor: 'blue',
        extensionSendMessage,
        getExtensionInfo: async () => {
            const response = await refreshExtensionInfo({ force: true });
            return {
                ...(response || { ok: false, reason: 'empty-extension-info-response' }),
                contentScript: true,
                serviceWorker: response?.ok === true,
            };
        },
    });
    const normalizeText = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    const hashText = (value) => {
        const text = String(value || '');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
    };
    const tokenScore = (needle, haystack) => {
        const normalizedNeedle = normalizeText(needle);
        const normalizedHaystack = normalizeText(haystack);
        if (!normalizedNeedle || !normalizedHaystack)
            return 0;
        if (normalizedHaystack.includes(normalizedNeedle))
            return 1;
        const needleTokens = new Set(normalizedNeedle.split(' ').filter((token) => token.length > 2));
        if (!needleTokens.size)
            return 0;
        const haystackTokens = new Set(normalizedHaystack.split(' ').filter((token) => token.length > 2));
        let overlap = 0;
        for (const token of needleTokens) {
            if (haystackTokens.has(token))
                overlap += 1;
        }
        return overlap / needleTokens.size;
    };
    const candidateScoring = (candidate = {}) => candidate.scoring && typeof candidate.scoring === 'object' ? candidate.scoring : candidate;
    const hasUserPromptScoring = (candidate = {}) => {
        const scoring = candidateScoring(candidate);
        return Boolean(String(scoring.firstPrompt || '').trim() || String(scoring.lastPrompt || '').trim());
    };
    const isPromptlessSingleTurnCandidate = (candidate = {}) => Number(candidate.turnCount) === 1 && !hasUserPromptScoring(candidate);
    const candidateFields = (candidate = {}) => {
        const scoring = candidateScoring(candidate);
        const promptlessSingleTurn = isPromptlessSingleTurnCandidate(candidate);
        const fields = [];
        if (scoring.firstPrompt)
            fields.push({ kind: 'created', text: scoring.firstPrompt });
        if (scoring.lastPrompt)
            fields.push({ kind: 'last_message', text: scoring.lastPrompt });
        const assistantKind = promptlessSingleTurn ? 'unknown' : 'last_message';
        for (const sample of scoring.assistantSamples || []) {
            if (sample)
                fields.push({ kind: assistantKind, text: sample });
        }
        if (scoring.title && (!fields.length || promptlessSingleTurn)) {
            fields.push({ kind: 'unknown', text: scoring.title });
        }
        return fields;
    };
    const candidateProbeFields = (candidate = {}) => {
        const scoring = candidate.scoring && typeof candidate.scoring === 'object' ? candidate.scoring : candidate;
        const fields = candidateFields(candidate);
        if (scoring.title)
            fields.push({ kind: 'probe', text: scoring.title });
        return fields;
    };
    const scoreFields = (fields, text) => {
        let best = { score: 0, kind: 'unknown', sampleHash: null, sampleLength: 0 };
        for (const field of fields) {
            const score = tokenScore(field.text, text);
            if (score > best.score) {
                best = {
                    score,
                    kind: field.kind,
                    sampleHash: hashText(field.text),
                    sampleLength: String(field.text || '').length,
                };
            }
        }
        return best;
    };
    const scoreCandidate = (candidate, text) => scoreFields(candidateFields(candidate), text);
    const scoreCandidateProbe = (candidate, text) => scoreFields(candidateProbeFields(candidate), text);
    const scoreCandidateByKind = (candidate, text) => {
        const byKind = new Map();
        for (const field of candidateFields(candidate)) {
            const score = tokenScore(field.text, text);
            const current = byKind.get(field.kind);
            if (!current || score > current.score) {
                byKind.set(field.kind, {
                    score,
                    kind: field.kind,
                    sampleHash: hashText(field.text),
                    sampleLength: String(field.text || '').length,
                });
            }
        }
        if (byKind.size === 0)
            return [scoreCandidate(candidate, text)];
        return Array.from(byKind.values());
    };
    const requiredKindsForCandidate = (candidate = {}) => {
        if (isPromptlessSingleTurnCandidate(candidate))
            return new Set(['unknown']);
        const scoring = candidateScoring(candidate);
        const kinds = new Set();
        if (scoring.firstPrompt)
            kinds.add('created');
        if (scoring.lastPrompt)
            kinds.add('last_message');
        if (kinds.size)
            return kinds;
        const fieldKinds = new Set(candidateFields(candidate).map((field) => field.kind));
        return fieldKinds.size ? fieldKinds : new Set(['unknown']);
    };
    const parseNumericTimestamp = (value) => {
        const raw = String(value || '').trim();
        if (!raw)
            return null;
        const number = Number(raw.replace(/[^\d]/g, ''));
        if (!Number.isFinite(number) || number <= 0)
            return null;
        if (number > 10_000_000_000_000)
            return portableIsoSeconds(new Date(Math.floor(number / 1000)));
        if (number > 10_000_000_000)
            return portableIsoSeconds(new Date(number));
        return portableIsoSeconds(new Date(number * 1000));
    };
    const PT_MONTHS = {
        jan: 0,
        janeiro: 0,
        fev: 1,
        fevereiro: 1,
        mar: 2,
        marco: 2,
        março: 2,
        abr: 3,
        abril: 3,
        mai: 4,
        maio: 4,
        jun: 5,
        junho: 5,
        jul: 6,
        julho: 6,
        ago: 7,
        agosto: 7,
        set: 8,
        setembro: 8,
        out: 9,
        outubro: 9,
        nov: 10,
        novembro: 10,
        dez: 11,
        dezembro: 11,
    };
    const EN_MONTHS = {
        jan: 0,
        january: 0,
        feb: 1,
        february: 1,
        mar: 2,
        march: 2,
        apr: 3,
        april: 3,
        may: 4,
        jun: 5,
        june: 5,
        jul: 6,
        july: 6,
        aug: 7,
        august: 7,
        sep: 8,
        sept: 8,
        september: 8,
        oct: 9,
        october: 9,
        nov: 10,
        november: 10,
        dec: 11,
        december: 11,
    };
    const parseTimeParts = (text) => {
        const match = String(text || '').match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
        if (!match)
            return null;
        let hour = Number(match[1]);
        const minute = Number(match[2]);
        const meridiem = String(match[3] || '').toUpperCase();
        if (meridiem === 'PM' && hour < 12)
            hour += 12;
        if (meridiem === 'AM' && hour === 12)
            hour = 0;
        if (!Number.isFinite(hour) || !Number.isFinite(minute))
            return null;
        return { hour, minute, second: 0 };
    };
    const localIsoFromParts = ({ year, month, day }, time) => portableIsoSeconds(new Date(year, month, day, time.hour, time.minute, time.second));
    const parsePortugueseDate = (dateText, timeText) => {
        const normalized = normalizeText(dateText);
        const match = normalized.match(/\b(\d{1,2})\s+de\s+([a-z.]+)(?:\s+de\s+(\d{4}))?\b/);
        const time = parseTimeParts(timeText);
        if (!match || !time)
            return null;
        const month = PT_MONTHS[String(match[2] || '').replace(/\./g, '')];
        if (month === undefined)
            return null;
        return localIsoFromParts({
            year: Number(match[3] || new Date().getFullYear()),
            month,
            day: Number(match[1]),
        }, time);
    };
    const parseEnglishDate = (dateText, timeText) => {
        const normalized = normalizeText(dateText);
        const match = normalized.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/);
        const time = parseTimeParts(timeText);
        if (!match || !time)
            return null;
        const month = EN_MONTHS[String(match[1] || '').replace(/\./g, '')];
        if (month === undefined)
            return null;
        return localIsoFromParts({
            year: Number(match[3] || new Date().getFullYear()),
            month,
            day: Number(match[2]),
        }, time);
    };
    const parseRelativeDate = (dateText, timeText) => {
        const normalized = normalizeText(dateText);
        const time = parseTimeParts(timeText);
        if (!time)
            return null;
        const now = new Date();
        let offsetDays = null;
        if (/\b(today|hoje)\b/.test(normalized) || normalized.startsWith('today') || normalized.startsWith('hoje')) {
            offsetDays = 0;
        }
        if (/\b(yesterday|ontem)\b/.test(normalized) ||
            normalized.startsWith('yesterday') ||
            normalized.startsWith('ontem')) {
            offsetDays = -1;
        }
        if (offsetDays === null)
            return null;
        const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
        return localIsoFromParts({ year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }, time);
    };
    const parseTextualTimestamp = (dateText, cardText) => {
        const time = parseTimeParts(cardText);
        if (!dateText || !time)
            return null;
        const relative = parseRelativeDate(dateText, cardText);
        if (relative)
            return relative;
        const pt = parsePortugueseDate(dateText, cardText);
        if (pt)
            return pt;
        const en = parseEnglishDate(dateText, cardText);
        if (en)
            return en;
        const timeText = String(cardText)
            .match(/(?:^|[^\d])(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i)?.[1] || '';
        const parsed = new Date(`${dateText} ${timeText}`);
        if (Number.isNaN(parsed.getTime()))
            return null;
        return portableIsoSeconds(parsed);
    };
    const looksLikeDateContext = (text) => {
        const normalized = normalizeText(text);
        if (!normalized || normalized.length > 90)
            return false;
        return (/\b(today|yesterday|hoje|ontem)\b/.test(normalized) ||
            normalized.startsWith('today') ||
            normalized.startsWith('yesterday') ||
            normalized.startsWith('hoje') ||
            normalized.startsWith('ontem') ||
            /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/.test(normalized) ||
            /\b\d{1,2}\s+de\s+[a-z.]+/.test(normalized));
    };
    const findDateContextText = (card) => {
        for (let node = card, depth = 0; node && node !== document.body && depth < 8; node = node.parentElement, depth += 1) {
            let sibling = node.previousElementSibling;
            for (let scanned = 0; sibling && scanned < DATE_CONTEXT_PREVIOUS_SIBLING_LIMIT; sibling = sibling.previousElementSibling, scanned += 1) {
                const directText = String(sibling.textContent || '').replace(/\s+/g, ' ').trim();
                if (looksLikeDateContext(directText))
                    return directText;
                const heading = Array.from(sibling.querySelectorAll('h1,h2,h3,[role="heading"],time'))
                    .reverse()
                    .find((el) => looksLikeDateContext(el.textContent || ''));
                if (heading)
                    return String(heading.textContent || '').replace(/\s+/g, ' ').trim();
            }
        }
        return '';
    };
    const extractCardDate = (card) => {
        const timestampEl = card.closest('[data-timestamp]') || card.querySelector('[data-timestamp]');
        const numeric = parseNumericTimestamp(card.getAttribute('data-timestamp')) ||
            parseNumericTimestamp(timestampEl?.getAttribute('data-timestamp')) ||
            parseNumericTimestamp(card.getAttribute('data-time'));
        if (numeric)
            return numeric;
        const cardText = card.textContent || '';
        const dateCandidates = [
            card.getAttribute('data-date'),
            card.closest('[data-date]')?.getAttribute('data-date'),
            card.querySelector('[data-date]')?.getAttribute('data-date'),
            findDateContextText(card),
        ].filter(Boolean);
        for (const dateText of dateCandidates) {
            const parsed = parseTextualTimestamp(dateText, cardText);
            if (parsed)
                return parsed;
        }
        return null;
    };
    const findActivityCards = () => {
        const selectors = [
            '[data-timestamp]',
            '[data-date]',
            '[data-gm-activity-card]',
            '.activity-card',
            'c-wiz',
        ];
        const nestedCardSelector = '[data-timestamp],[data-date],[data-gm-activity-card],.activity-card';
        const isActivityLike = (el) => {
            const text = normalizeText(el.textContent || '');
            return text.includes('gemini') || Boolean(el.querySelector('[data-gm-activity-details]'));
        };
        const containsNestedActivity = (el) => Array.from(el.querySelectorAll(nestedCardSelector)).some((child) => child !== el && isActivityLike(child));
        const seen = new Set();
        const cards = [];
        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (!(el instanceof Element) || seen.has(el))
                    continue;
                if (!isActivityLike(el) || containsNestedActivity(el))
                    continue;
                seen.add(el);
                cards.push(el);
            }
        }
        return cards;
    };
    const detailsButtonFor = (card) => Array.from(card.querySelectorAll('button,[role="button"],a')).find((el) => {
        const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
        return /item details|detalhes|detalhe|details/i.test(label);
    }) || null;
    const detailDialogs = () => Array.from(document.querySelectorAll('[role="dialog"]'));
    const closeButtonForDialog = (dialog) => dialog
        ? Array.from(dialog.querySelectorAll('button,[role="button"]')).find((el) => /close|fechar|dismiss/i.test(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`))
        : null;
    const waitForDialogDismissal = async (dialog, beforeCount, timeoutMs = 900) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const currentCount = detailDialogs().length;
            if (!dialog?.isConnected || currentCount < beforeCount)
                return true;
            await sleep(30);
        }
        return !dialog?.isConnected || detailDialogs().length < beforeCount;
    };
    const closeOpenDetails = async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const dialogs = detailDialogs();
            const dialog = dialogs.at(-1);
            if (!dialog)
                return;
            const closeButton = closeButtonForDialog(dialog);
            try {
                if (closeButton)
                    closeButton.click();
                else
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
            catch {
                // Sem efeito em alguns DOMs de teste.
            }
            const dismissed = await waitForDialogDismissal(dialog, dialogs.length);
            if (!dismissed)
                return;
        }
    };
    const openDetailsForCard = async (card) => {
        await closeOpenDetails();
        const before = document.querySelectorAll('[role="dialog"],[data-gm-activity-details]').length;
        const button = detailsButtonFor(card);
        if (button) {
            try {
                button.click();
                await sleep(80);
            }
            catch {
                // O texto do card ainda pode ser suficiente para scoring.
            }
        }
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[data-gm-activity-details]'));
        if (dialogs.length > before)
            return dialogs.at(-1);
        return card.querySelector('[data-gm-activity-details]') || null;
    };
    const isDarkTheme = () => {
        try {
            return pageWindow.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true;
        }
        catch {
            return false;
        }
    };
    let activityProgressPort = null;
    const ensureActivityProgressPort = () => {
        if (!activityProgressPort) {
            activityProgressPort = createSharedProgressPort({
                dockId: PROGRESS_DOCK_ID,
                initialTitle: 'Buscando datas',
                documentRef: document,
                isDarkTheme,
                ensureDock: ensureSharedProgressDock,
                applyTheme: applySharedProgressDockTheme,
                getElements: getSharedProgressDockElements,
                setVisible: setSharedProgressDockVisible,
            });
        }
        return activityProgressPort;
    };
    const updateActivityProgressDock = () => {
        const port = ensureActivityProgressPort();
        const activityProgress = state.activityProgress;
        const mcpProgress = state.mcpProgress;
        if (!activityProgress && !mcpProgress) {
            port.hide();
            return;
        }
        const snapshot = activityProgress
            ? buildActivityProgressViewModel(activityProgress)
            : buildExportJobProgressViewModel(mcpProgress);
        port.update(snapshot);
        const { countEl } = getSharedProgressDockElements({
            dockId: PROGRESS_DOCK_ID,
        });
        if (countEl)
            countEl.textContent = snapshot.countLabel;
    };
    const beginActivityProgress = ({ candidateTotal = 0, maxCards = DEFAULT_MAX_CARDS } = {}) => {
        if (state.activityProgressHideTimer) {
            clearTimeout(state.activityProgressHideTimer);
            state.activityProgressHideTimer = 0;
        }
        state.activityProgress = {
            status: 'running',
            phase: 'scanning',
            candidateTotal,
            maxCards,
            scannedCardCount: 0,
            loadedCardCount: 0,
            resolvedCount: 0,
        };
        updateActivityProgressDock();
    };
    const updateActivityProgress = (patch = {}) => {
        if (!state.activityProgress)
            beginActivityProgress();
        state.activityProgress = {
            ...state.activityProgress,
            ...patch,
            status: patch.status || state.activityProgress?.status || 'running',
        };
        updateActivityProgressDock();
    };
    const finishActivityProgress = ({ status = 'completed', resolvedCount = null } = {}) => {
        if (!state.activityProgress)
            beginActivityProgress();
        state.activityProgress = {
            ...state.activityProgress,
            status,
            resolvedCount: resolvedCount ?? state.activityProgress.resolvedCount ?? 0,
        };
        updateActivityProgressDock();
        if (state.activityProgressHideTimer)
            clearTimeout(state.activityProgressHideTimer);
        state.activityProgressHideTimer = setTimeout(() => {
            state.activityProgress = null;
            state.activityProgressHideTimer = 0;
            updateActivityProgressDock();
        }, 3200);
        state.activityProgressHideTimer?.unref?.();
    };
    const MCP_TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
    const handleMcpJobProgressBroadcast = (jobProgress) => {
        if (state.mcpProgressHideTimer) {
            clearTimeout(state.mcpProgressHideTimer);
            state.mcpProgressHideTimer = 0;
        }
        if (!jobProgress) {
            state.mcpProgress = null;
            updateActivityProgressDock();
            return;
        }
        if (jobProgress.source && jobProgress.source !== 'mcp')
            return;
        const total = Math.max(Number(jobProgress.total || jobProgress.requested || 1), 1);
        const batchPosition = Number(jobProgress.position ?? jobProgress.current ?? 0);
        state.mcpProgress = {
            ...jobProgress,
            sourceKind: 'export-job',
            requested: total,
            batchTotal: total,
            batchPosition: Number.isFinite(batchPosition) && batchPosition > 0 ? batchPosition : null,
            progressMessage: jobProgress.label || jobProgress.progressMessage || null,
        };
        updateActivityProgressDock();
        if (MCP_TERMINAL_STATUSES.has(String(jobProgress.status || ''))) {
            state.mcpProgressHideTimer = setTimeout(() => {
                state.mcpProgress = null;
                state.mcpProgressHideTimer = 0;
                updateActivityProgressDock();
            }, 4200);
            state.mcpProgressHideTimer?.unref?.();
        }
    };
    const sanitizedMatch = ({ candidate, card, score, cardIndex }) => ({
        chatId: String(candidate.chatId || ''),
        date: extractCardDate(card),
        kind: score.kind,
        score: Number(score.score.toFixed(4)),
        textHash: hashText(card.textContent || ''),
        sampleHash: score.sampleHash,
        sampleLength: score.sampleLength,
        cardIndex,
    });
    const genericUsageMatch = ({ candidate, card, cardIndex }) => ({
        chatId: String(candidate.chatId || ''),
        date: extractCardDate(card),
        kind: 'unknown',
        source: 'my-activity-web',
        confidence: 'weak',
        score: MATCH_THRESHOLD,
        textHash: hashText(card.textContent || ''),
        sampleHash: hashText('Gemini Apps Used Gemini Apps'),
        sampleLength: 0,
        cardIndex,
        warnings: ['generic_usage_card_for_promptless_single_turn'],
    });
    const sampleText = (value, max = 240) => {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
    };
    const diagnoseLoadedCards = (candidates, options = {}) => {
        const candidateEntries = (candidates || [])
            .filter((candidate) => candidate?.chatId)
            .map((candidate) => [String(candidate.chatId), candidate]);
        const cards = findActivityCards().slice(0, options.maxCards || DEFAULT_MAX_CARDS);
        const topLimit = Math.max(0, Math.min(10, Number(options.topMatches || 5)));
        const describeElement = (el) => {
            if (!el)
                return null;
            const text = el.textContent || '';
            return {
                tag: String(el.tagName || '').toLowerCase(),
                id: el.id || '',
                className: String(el.className || ''),
                textHash: hashText(text),
                textLength: text.length,
                textSample: sampleText(text),
            };
        };
        const nearbyStructure = (card) => {
            if (options.includeStructureSample !== true)
                return undefined;
            const ancestors = [];
            for (let node = card, depth = 0; node && node !== document.body && depth < 5; node = node.parentElement, depth += 1) {
                ancestors.push({
                    depth,
                    element: describeElement(node),
                    previousSiblings: Array.from({ length: 4 }).reduce((items) => {
                        const previous = items.length === 0 ? node.previousElementSibling : items.at(-1)?.__previous?.previousElementSibling;
                        if (!previous)
                            return items;
                        items.push({ ...describeElement(previous), __previous: previous });
                        return items;
                    }, []).map(({ __previous, ...item }) => item),
                });
            }
            return ancestors;
        };
        return {
            cardCount: cards.length,
            cards: cards.map((card, cardIndex) => {
                const text = card.textContent || '';
                const dateContext = findDateContextText(card);
                const preliminary = [];
                for (const [chatId, candidate] of candidateEntries) {
                    const score = scoreCandidateProbe(candidate, text);
                    if (score.score <= 0)
                        continue;
                    preliminary.push({
                        chatId,
                        score: Number(score.score.toFixed(4)),
                        kind: score.kind,
                        sampleHash: score.sampleHash,
                        sampleLength: score.sampleLength,
                    });
                }
                preliminary.sort((left, right) => {
                    if (right.score !== left.score)
                        return right.score - left.score;
                    return right.sampleLength - left.sampleLength;
                });
                return {
                    cardIndex,
                    date: extractCardDate(card),
                    dateContextHash: dateContext ? hashText(dateContext) : null,
                    dateContextLength: dateContext.length,
                    ...(options.includeTextSample === true && dateContext
                        ? { dateContextSample: sampleText(dateContext) }
                        : {}),
                    ...(options.includeTextSample === true
                        ? {
                            timeProbe: parseTimeParts(text),
                            dateContextParsed: dateContext ? parseTextualTimestamp(dateContext, text) : null,
                        }
                        : {}),
                    textHash: hashText(text),
                    textLength: text.length,
                    ...(options.includeTextSample === true ? { textSample: sampleText(text) } : {}),
                    hasDetailsButton: Boolean(detailsButtonFor(card)),
                    hasInlineDetails: Boolean(card.querySelector('[data-gm-activity-details]')),
                    topPreliminary: preliminary.slice(0, topLimit),
                    ...(options.includeStructureSample === true ? { nearbyStructure: nearbyStructure(card) } : {}),
                };
            }),
        };
    };
    const scanLoadedCards = async (candidates, options = {}) => {
        const candidateMap = new Map((candidates || [])
            .filter((candidate) => candidate?.chatId)
            .map((candidate) => [String(candidate.chatId), candidate]));
        const foundKinds = new Map();
        const requiredKinds = new Map();
        for (const [chatId, candidate] of candidateMap.entries()) {
            requiredKinds.set(chatId, requiredKindsForCandidate(candidate));
            foundKinds.set(chatId, new Set());
        }
        const matches = [];
        let loadedCardCount = 0;
        let lastSeenActivityToken = null;
        const resolvedChatIdsForFoundKinds = () => Array.from(candidateMap.keys())
            .filter((chatId) => {
            const required = requiredKinds.get(chatId) || new Set();
            const found = foundKinds.get(chatId) || new Set();
            return Array.from(required).every((kind) => found.has(kind));
        })
            .sort();
        const unresolvedEntries = () => Array.from(candidateMap.entries()).filter(([chatId]) => {
            const required = requiredKinds.get(chatId) || new Set();
            const found = foundKinds.get(chatId) || new Set();
            return !Array.from(required).every((kind) => found.has(kind));
        });
        const isGenericUsageCard = (card) => {
            const normalized = normalizeText(card.textContent || '');
            return ((normalized.includes('gemini appsused gemini apps') ||
                normalized.includes('gemini apps used gemini apps')) &&
                !normalized.includes('prompted'));
        };
        const cards = findActivityCards().slice(0, options.maxCards || DEFAULT_MAX_CARDS);
        loadedCardCount = cards.length;
        for (let cardIndex = 0; cardIndex < cards.length; cardIndex += 1) {
            const card = cards[cardIndex];
            const closedText = card.textContent || '';
            let entriesToScore = unresolvedEntries();
            let detail = null;
            if (options.openDetails === true) {
                const preliminary = [];
                for (const [chatId, candidate] of entriesToScore) {
                    const score = scoreCandidateProbe(candidate, closedText);
                    if (score.score >= MATCH_THRESHOLD)
                        preliminary.push({ chatId, candidate, score });
                }
                preliminary.sort((left, right) => {
                    if (right.score.score !== left.score.score)
                        return right.score.score - left.score.score;
                    return right.score.sampleLength - left.score.sampleLength;
                });
                entriesToScore = preliminary.map((item) => [item.chatId, item.candidate]);
                if (entriesToScore.length > 0)
                    detail = await openDetailsForCard(card);
            }
            else {
                detail = card.querySelector('[data-gm-activity-details]');
            }
            const scoringText = `${closedText}\n${detail?.textContent || ''}`;
            const cardMatches = [];
            for (const [chatId, candidate] of entriesToScore) {
                for (const score of scoreCandidateByKind(candidate, scoringText)) {
                    if (score.score < MATCH_THRESHOLD)
                        continue;
                    if (foundKinds.get(chatId)?.has(score.kind))
                        continue;
                    const match = sanitizedMatch({ candidate, card, score, cardIndex });
                    if (!match.date)
                        continue;
                    cardMatches.push({ chatId, match });
                }
            }
            cardMatches.sort((left, right) => {
                if (right.match.score !== left.match.score)
                    return right.match.score - left.match.score;
                return right.match.sampleLength - left.match.sampleLength;
            });
            const bestChatId = cardMatches[0]?.chatId || null;
            const acceptedCardMatchKeys = new Set();
            for (const item of cardMatches) {
                if (item.chatId !== bestChatId)
                    continue;
                const key = `${item.chatId}:${item.match.kind || 'unknown'}`;
                if (acceptedCardMatchKeys.has(key))
                    continue;
                acceptedCardMatchKeys.add(key);
                matches.push(item.match);
                foundKinds.get(item.chatId)?.add(item.match.kind);
            }
            lastSeenActivityToken = extractCardDate(card) || hashText(card.textContent || '');
            if (options.openDetails === true)
                await closeOpenDetails();
            const resolvedCount = resolvedChatIdsForFoundKinds().length;
            options.onProgress?.({
                scannedCardCount: cardIndex + 1,
                loadedCardCount,
                resolvedCount,
                phase: 'scanning',
            });
            const allResolved = Array.from(candidateMap.keys()).every((chatId) => {
                const required = requiredKinds.get(chatId) || new Set();
                const found = foundKinds.get(chatId) || new Set();
                return Array.from(required).every((kind) => found.has(kind));
            });
            if (allResolved)
                break;
        }
        const genericUsageCards = cards
            .map((card, cardIndex) => ({ card, cardIndex, date: extractCardDate(card) }))
            .filter((item) => item.date && isGenericUsageCard(item.card));
        const promptlessUnresolved = unresolvedEntries().filter(([, candidate]) => isPromptlessSingleTurnCandidate(candidate));
        if (genericUsageCards.length === 1 && promptlessUnresolved.length === 1) {
            const [chatId, candidate] = promptlessUnresolved[0];
            const match = genericUsageMatch({
                candidate,
                card: genericUsageCards[0].card,
                cardIndex: genericUsageCards[0].cardIndex,
            });
            matches.push(match);
            foundKinds.get(chatId)?.add('unknown');
        }
        return {
            matches,
            loadedCardCount,
            lastSeenActivityToken,
            resolvedChatIds: resolvedChatIdsForFoundKinds(),
        };
    };
    const resolvedChatIdsForMatches = (candidates, matches) => {
        const requiredKindsByChatId = new Map();
        for (const candidate of candidates || []) {
            if (!candidate?.chatId)
                continue;
            const chatId = String(candidate.chatId);
            requiredKindsByChatId.set(chatId, requiredKindsForCandidate(candidate));
        }
        const foundKindsByChatId = new Map();
        for (const match of matches || []) {
            const chatId = String(match?.chatId || '');
            if (!chatId || !requiredKindsByChatId.has(chatId))
                continue;
            const found = foundKindsByChatId.get(chatId) || new Set();
            found.add(match.kind || 'unknown');
            foundKindsByChatId.set(chatId, found);
        }
        return Array.from(requiredKindsByChatId.entries())
            .filter(([chatId, required]) => {
            const found = foundKindsByChatId.get(chatId) || new Set();
            return Array.from(required).every((kind) => found.has(kind));
        })
            .map(([chatId]) => chatId)
            .sort();
    };
    const scanActivityPage = async (args = {}) => {
        const candidates = Array.isArray(args.candidates) ? args.candidates : [];
        const maxCards = Math.max(1, Math.min(DEFAULT_MAX_CARDS, Number(args.maxCards || DEFAULT_MAX_CARDS)));
        const maxScrollRounds = Math.max(0, Math.min(DEFAULT_MAX_SCROLL_ROUNDS, Number(args.maxScrollRounds || DEFAULT_MAX_SCROLL_ROUNDS)));
        if (args.diagnoseCards === true) {
            const diagnostics = diagnoseLoadedCards(candidates, {
                maxCards,
                topMatches: args.topMatches,
                includeTextSample: args.includeTextSample === true,
                includeStructureSample: args.includeStructureSample === true,
            });
            return {
                ok: true,
                source: 'my-activity-web',
                diagnostics,
                checkpoint: {
                    lastSeenActivityToken: diagnostics.cards.at(-1)?.date || diagnostics.cards.at(-1)?.textHash || null,
                    loadedCardCount: diagnostics.cardCount,
                    resolvedChatIds: [],
                },
            };
        }
        beginActivityProgress({ candidateTotal: candidates.length, maxCards });
        try {
            const allMatches = [];
            let checkpoint = {
                lastSeenActivityToken: args.resume?.lastSeenActivityToken || null,
                loadedCardCount: 0,
                resolvedChatIds: [],
            };
            let previousCount = -1;
            for (let round = 0; round <= maxScrollRounds; round += 1) {
                const partial = await scanLoadedCards(candidates, {
                    maxCards,
                    openDetails: args.openDetails === true,
                    onProgress: (progress) => {
                        updateActivityProgress({
                            ...progress,
                            resolvedCount: Array.from(new Set(allMatches.map((match) => match.chatId))).length,
                        });
                    },
                });
                for (const match of partial.matches) {
                    if (!allMatches.some((existing) => existing.chatId === match.chatId &&
                        existing.date === match.date &&
                        (existing.kind || 'unknown') === (match.kind || 'unknown'))) {
                        allMatches.push(match);
                    }
                }
                checkpoint = {
                    lastSeenActivityToken: partial.lastSeenActivityToken || checkpoint.lastSeenActivityToken,
                    loadedCardCount: partial.loadedCardCount,
                    resolvedChatIds: resolvedChatIdsForMatches(candidates, allMatches),
                };
                updateActivityProgress({
                    scannedCardCount: partial.loadedCardCount,
                    loadedCardCount: partial.loadedCardCount,
                    resolvedCount: checkpoint.resolvedChatIds.length,
                    phase: 'scrolling',
                });
                if (checkpoint.resolvedChatIds.length >= candidates.length)
                    break;
                if (partial.loadedCardCount >= maxCards)
                    break;
                if (partial.loadedCardCount === previousCount)
                    break;
                previousCount = partial.loadedCardCount;
                window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight || 0);
                await sleep(SCROLL_SETTLE_MS);
            }
            await closeOpenDetails();
            finishActivityProgress({ status: 'completed', resolvedCount: checkpoint.resolvedChatIds.length });
            return {
                ok: true,
                source: 'my-activity-web',
                matches: allMatches,
                checkpoint,
            };
        }
        catch (err) {
            await closeOpenDetails();
            finishActivityProgress({ status: 'failed' });
            throw err;
        }
    };
    const buildHeartbeatPayload = () => ({
        clientId: state.clientId,
        kind: 'activity',
        extensionVersion: state.extensionVersion,
        protocolVersion: state.protocolVersion,
        buildStamp: state.buildStamp,
        tabId: state.tabId,
        windowId: state.windowId,
        isActiveTab: state.isActiveTab,
        tabClaim: state.tabClaim,
        page: {
            kind: 'activity',
            url: location.href,
            path: location.pathname,
            title: document.title,
        },
        capabilities: ['activity-scan-batch-v1', 'tab-activation-v1'],
    });
    let contentScriptMessageListenerInstalled = false;
    const contentScriptRuntimeStatus = () => {
        const heartbeat = buildHeartbeatPayload();
        return {
            ok: true,
            kind: 'activity',
            contentScript: true,
            extensionVersion: state.extensionVersion || '0.8.60',
            version: state.extensionVersion || '0.8.60',
            protocolVersion: state.protocolVersion ?? Number('2'),
            buildStamp: state.buildStamp || '20260604-0112',
            tabId: state.tabId ?? null,
            windowId: state.windowId ?? null,
            isActiveTab: state.isActiveTab ?? null,
            clientId: state.clientId || null,
            page: heartbeat.page,
        };
    };
    const installContentScriptMessageListener = () => {
        if (contentScriptMessageListenerInstalled ||
            typeof chrome === 'undefined' ||
            !chrome.runtime?.onMessage?.addListener) {
            return;
        }
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type !== CONTENT_SCRIPT_PING_TYPE)
                return false;
            sendResponse(contentScriptRuntimeStatus());
            return false;
        });
        contentScriptMessageListenerInstalled = true;
    };
    const executeCommand = async (command) => {
        const sharedResult = await sharedTabCommands.execute(command);
        if (sharedResult !== undefined)
            return sharedResult;
        if (command.type === 'get-extension-info') {
            const response = await refreshExtensionInfo({ force: true });
            return {
                ...(response || { ok: false, reason: 'empty-extension-info-response' }),
                contentScript: true,
                serviceWorker: response?.ok === true,
            };
        }
        if (command.type === 'reload-extension-self') {
            return extensionSendMessage({
                type: 'RELOAD_SELF',
                reason: command.args?.reason || 'activity-bridge-command',
                expectedExtensionVersion: command.args?.expectedExtensionVersion || null,
                expectedProtocolVersion: command.args?.expectedProtocolVersion || null,
                expectedBuildStamp: command.args?.expectedBuildStamp || null,
            }, { timeoutMs: 3500 });
        }
        if (command.type === 'activate-browser-tab') {
            const requestedTabId = Number(command.args?.tabId ?? command.args?.targetTabId);
            return extensionSendMessage({
                type: 'gemini-md-export/activate-tab',
                tabId: Number.isInteger(requestedTabId) ? requestedTabId : undefined,
                reason: command.args?.reason || 'activity-bridge-command',
                focusWindow: command.args?.focusWindow === true,
            }, { timeoutMs: 5000 });
        }
        if (command.type === 'claim-tab') {
            const args = command.args || {};
            const claim = {
                claimId: String(args.claimId || '').trim(),
                sessionId: args.sessionId || null,
                label: args.label || TAB_CLAIM_DEFAULT_LABEL,
                color: args.color || 'blue',
                expiresAt: args.expiresAt || null,
                visualGroupTabId: numberOrNull(args.visualGroupTabId || args.groupWithTabId),
            };
            if (!claim.claimId)
                return { ok: false, reason: 'claim-id-required' };
            const response = await extensionSendMessage({
                type: 'gemini-md-export/claim-tab',
                ...claim,
            }, { timeoutMs: 5000 });
            if (response?.ok) {
                state.tabClaim = {
                    ...claim,
                    tabId: response.tabId ?? response.visual?.tabId ?? state.tabId,
                    windowId: response.windowId ?? state.windowId,
                    visual: response.visual || response,
                };
            }
            return response || { ok: false, reason: 'empty-claim-response' };
        }
        if (command.type === 'release-tab-claim') {
            const response = await extensionSendMessage({
                type: 'gemini-md-export/release-tab-claim',
                tabId: command.args?.tabId ?? state.tabId,
                claimId: command.args?.claimId || state.tabClaim?.claimId || null,
                reason: command.args?.reason || 'activity-bridge-command',
            }, { timeoutMs: 5000 });
            if (response?.ok)
                state.tabClaim = null;
            return response || { ok: false, reason: 'empty-release-response' };
        }
        if (command.type === 'release-tab-claim-by-tab-id') {
            const requestedTabId = Number(command.args?.tabId);
            const response = await extensionSendMessage({
                type: 'gemini-md-export/release-tab-claim',
                tabId: Number.isInteger(requestedTabId) ? requestedTabId : state.tabId,
                claimId: command.args?.claimId || state.tabClaim?.claimId || null,
                reason: command.args?.reason || 'activity-bridge-command-tab-id-release',
            }, { timeoutMs: 5000 });
            const targetsThisTab = Number.isInteger(requestedTabId) &&
                Number.isInteger(Number(state.tabId)) &&
                requestedTabId === Number(state.tabId);
            const claimMatches = !command.args?.claimId || !state.tabClaim?.claimId || state.tabClaim.claimId === command.args.claimId;
            if (response?.ok && targetsThisTab && claimMatches)
                state.tabClaim = null;
            return response || { ok: false, reason: 'empty-release-response' };
        }
        if (command.type === 'activity-scan-batch') {
            return scanActivityPage(command.args || {});
        }
        return {
            ok: false,
            error: `Comando desconhecido para My Activity: ${command.type || 'sem tipo'}`,
        };
    };
    let activityBridgeClient = null;
    const syncActivityBridgeState = () => {
        if (!activityBridgeClient)
            return;
        state.clientId = activityBridgeClient.state.clientId;
        state.started = activityBridgeClient.state.started;
        state.heartbeatTimer = activityBridgeClient.state.heartbeatTimer;
        state.heartbeatInFlight = activityBridgeClient.state.heartbeatInFlight;
        state.eventSource = activityBridgeClient.state.eventSource;
        state.commandResultCache = activityBridgeClient.state.commandResultCache;
    };
    const getActivityBridgeClient = () => {
        if (activityBridgeClient)
            return activityBridgeClient;
        state.clientId = state.clientId || getOrCreateActivityClientId();
        activityBridgeClient = createBrowserBridgeClient({
            kind: 'activity',
            bridgeBaseUrl: BRIDGE_BASE_URL,
            capabilities: ['activity-scan-batch-v1', 'tab-activation-v1'],
            clientId: state.clientId,
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            pollTimeoutMs: COMMAND_POLL_TIMEOUT_MS,
            getPageSnapshot: () => buildHeartbeatPayload().page,
            buildHeartbeatPayload,
            beforeHeartbeat: () => refreshExtensionInfo(),
            executeCommand,
            bridgeRequest,
            eventSourceFactory: (url) => {
                if (typeof EventSource !== 'function')
                    throw new Error('EventSource indisponível');
                return new EventSource(url);
            },
            onJobProgress: handleMcpJobProgressBroadcast,
            onError: () => {
                // Bridge pode estar fechado enquanto o usuário navega. O próximo heartbeat tenta de novo.
            },
        });
        syncActivityBridgeState();
        return activityBridgeClient;
    };
    const sendHeartbeat = async () => {
        const client = getActivityBridgeClient();
        await client.sendHeartbeat();
        syncActivityBridgeState();
    };
    const pollCommands = async () => {
        const client = getActivityBridgeClient();
        await client.pollCommands();
        syncActivityBridgeState();
    };
    const connectEvents = () => {
        const client = getActivityBridgeClient();
        client.connectEvents();
        syncActivityBridgeState();
    };
    const startBridgeClient = async () => {
        const client = getActivityBridgeClient();
        if (client.state.started) {
            syncActivityBridgeState();
            return;
        }
        await client.start({ connectEvents: false });
        syncActivityBridgeState();
        await client.sendHeartbeat();
        client.connectEvents();
        syncActivityBridgeState();
    };
    const stopBridgeClient = () => {
        getActivityBridgeClient().stop();
        syncActivityBridgeState();
    };
    pageWindow.__geminiMdActivityDebug = {
        scanActivityPage,
        executeCommand,
        startBridgeClient,
        stopBridgeClient,
        _private: {
            beginActivityProgress,
            updateActivityProgress,
            finishActivityProgress,
            handleMcpJobProgressBroadcast,
            buildHeartbeatPayload,
            getActivityBridgeClient,
            extractCardDate,
            hashText,
            normalizeText,
        },
    };
    installContentScriptMessageListener();
    if (!pageWindow.__GEMINI_MD_ACTIVITY_DISABLE_AUTO_START__) {
        startBridgeClient();
    }
})();
