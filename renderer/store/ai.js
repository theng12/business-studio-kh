// AI Studio slice — models, prompts, tasks, gallery, credits, and the
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
    aiSelectedModelKey: 'kie:nano-banana-pro',
    aiPromptText: '',
    // v0.26.22: added `autoAddToProduct` + `autoPromoteAsMain` defaults
    // (both false). Per-product AI Studio reads these for two new
    // checkboxes; the queue runner reads them off task.options to decide
    // whether to attach the first variant back onto the product
    // automatically. autoPromoteAsMain implies autoAddToProduct in the
    // runner (promote does add + setMain).
    aiOptions: { size: '1:1', nVariants: 1, numImages: 1, autoAddToProduct: false, autoPromoteAsMain: false },
    aiCredits: { kie: null, fal: null, fetchedAt: 0 },

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

    async refreshAiCredits() {
      if (!window.api) return;
      // v0.1.22: in client mode the generations run on the server Mac with ITS
      // keys, so there is nothing here to read. This used to fire anyway and fail
      // silently on every AI Studio mount and refresh.
      if (get().appMode === 'client') return;
      try { set({ aiCredits: await window.api.ai.getCredits() }); }
      catch { /* keep last known */ }
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
      /* v0.1.27: reset the per-task count when the model changes.
       *
       * The count control is shown conditionally — a `nVariants` dropdown for
       * models that declare one, a `numImages` box for fal models — but the
       * value itself lives in `aiOptions` and survived a model switch. So
       * picking 4 images on a fal model and then switching to a kie model left
       * `numImages: 4` in state with no control to change it, and the
       * confirmation dialog quoted 4 generations and 4× the cost for a run that
       * would produce one image (fal honours `numImages`, kie honours
       * `nVariants` — see main/ai/providers/). Clearing both on switch means a
       * count can never outlive the model it was chosen for. */
      set({ aiSelectedModelKey: key, aiOptions: { ...get().aiOptions, numImages: undefined, nVariants: undefined } });
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
      // Task just finished → balance changed. Refresh in the background.
      if (task.status === 'done' || task.status === 'failed') {
        // Debounce-ish: throttle to once per 10s.
        const last = get().aiCredits?.fetchedAt ?? 0;
        if (Date.now() - last > 10_000) get().refreshAiCredits();
      }
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
