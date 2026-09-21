// AI Studio slice — models, prompts, tasks, gallery, and the
// per-product source / prompt / options + queue actions.

let promptsRefreshSeq = 0;
let tasksRefreshSeq = 0;

export function createAiSlice(set, get) {
  return {
    // AI Studio
    aiModels: [],
    aiTasks: [],
    aiPrompts: [],
    aiGalleryByProduct: {},
    aiSourceProductId: null,
    aiSourceImagePath: null,
    // v0.1.46: the catalog is dynamic (OpenAI). `null` means "snap to the
    // first model the catalog returns" — AIStudio resolves this below.
    aiSelectedModelKey: null,
    aiPromptText: '',
    // v0.26.22: added `autoAddToProduct` + `autoPromoteAsMain` defaults
    // (both false). Per-product AI Studio reads these for two new
    // checkboxes; the queue runner reads them off task.options to decide
    // whether to attach the first variant back onto the product
    // automatically. autoPromoteAsMain implies autoAddToProduct in the
    // runner (promote does add + setMain).
    aiOptions: { size: 'auto', numImages: 1, autoAddToProduct: false, autoPromoteAsMain: false },

    async refreshAiModels() {
      if (!window.api) return;
      try { set({ aiModels: await window.api.ai.listModels() }); }
      catch (err) { get().addToast(err.message, 'error'); }
    },

    async refreshAiPrompts() {
      if (!window.api) return;
      const seq = ++promptsRefreshSeq;
      const companyId = get().activeCompanyId;
      if (!companyId) { set({ aiPrompts: [] }); return; }
      try {
        const aiPrompts = await window.api.ai.listPrompts(companyId);
        if (seq === promptsRefreshSeq && get().activeCompanyId === companyId) set({ aiPrompts });
      } catch (err) {
        if (seq === promptsRefreshSeq && get().activeCompanyId === companyId) get().addToast(err.message, 'error');
      }
    },

    async refreshAiTasks() {
      if (!window.api) return;
      const seq = ++tasksRefreshSeq;
      const companyId = get().activeCompanyId;
      if (!companyId) { set({ aiTasks: [] }); return; }
      try {
        const aiTasks = await window.api.ai.listTasks(companyId, { limit: 200 });
        if (seq === tasksRefreshSeq && get().activeCompanyId === companyId) set({ aiTasks });
      } catch (err) {
        if (seq === tasksRefreshSeq && get().activeCompanyId === companyId) get().addToast(err.message, 'error');
      }
    },

    async refreshAiGalleryFor(productId) {
      if (!window.api || !productId) return;
      const companyId = get().activeCompanyId;
      try {
        const entries = await window.api.ai.listGallery(productId);
        if (get().activeCompanyId !== companyId) return;
        set((s) => ({ aiGalleryByProduct: { ...s.aiGalleryByProduct, [productId]: entries } }));
      } catch (err) {
        if (get().activeCompanyId === companyId) get().addToast(err.message, 'error');
      }
    },

    setAiSourceProduct(productId) {
      set({ aiSourceProductId: productId, aiSourceImagePath: null });
      if (productId) get().refreshAiGalleryFor(productId);
    },
    setAiSourceImage(filepath) { set({ aiSourceImagePath: filepath }); },
    setAiSelectedModel(key) {
      /* Reset the per-task count when the model changes. The count control
       * is capability-driven (only some models accept n > 1), but the value
       * itself lives in `aiOptions` and would otherwise survive a model
       * switch — leaving a count no control can change, so the confirmation
       * dialog would quote generations the run would never produce. Clearing
       * it on switch means a count can never outlive the model it was chosen
       * for. The size/quality are likewise reset: they are validated against
       * the new model's capability lists when the picker renders. */
      set({ aiSelectedModelKey: key, aiOptions: { ...get().aiOptions, numImages: undefined, nVariants: undefined, size: undefined, quality: undefined } });
      // Persist as the default for the next app launch — covers the common
      // case where a user picks (say) nano-banana-pro once and wants it to
      // stick. Best-effort: if the IPC write fails (file lock, etc.) the
      // user's session keeps the new selection in memory; only the persistence
      // is lost.
      try { window.api?.settings?.setOne?.('aiDefaultModel', key); } catch (err) {
        // Selection still applies this session; only the saved default is lost.
        console.warn('[soft-failure] persist aiDefaultModel:', err?.message || err);
      }
    },
    setAiPrompt(text) { set({ aiPromptText: text }); },
    setAiOptions(patch) { set((s) => ({ aiOptions: { ...s.aiOptions, ...patch } })); },

    async queueAiTask(input) {
      const companyId = get().activeCompanyId;
      if (!companyId) throw new Error('Select a company first');
      const task = await window.api.ai.queueTask({ ...input, companyId });
      await get().refreshAiTasks();
      return task;
    },
    async repairAiTask(id) {
      await window.api.ai.repairTask(id);
      await get().refreshAiTasks();
    },
    async queueFreshAiTask(id) {
      await window.api.ai.queueFreshTask(id);
      await get().refreshAiTasks();
    },
    async cancelAiTask(id) {
      await window.api.ai.cancelTask(id);
      await get().refreshAiTasks();
    },
    async removeAiTask(id) {
      await window.api.ai.removeTask(id);
      await get().refreshAiTasks();
    },

    applyTaskUpdate(task) {
      set((s) => {
        const idx = s.aiTasks.findIndex((t) => t.id === task.id);
        if (idx === -1) return { aiTasks: [task, ...s.aiTasks] };
        const next = s.aiTasks.slice();
        next[idx] = task;
        return { aiTasks: next };
      });
    },

    applyGalleryAdded(entry) {
      if (!entry?.productId) return;
      set((s) => {
        const cur = s.aiGalleryByProduct[entry.productId] ?? [];
        return {
          aiGalleryByProduct: {
            ...s.aiGalleryByProduct,
            [entry.productId]: [entry, ...cur],
          },
        };
      });
    },
  };
}
